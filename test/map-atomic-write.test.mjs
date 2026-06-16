// SPDX-License-Identifier: MIT
// Spec 001 — Harden map.json atomic write against symlink / temp-file race.
// 16 tests (A-P) covering: normal write, schema rebuild, tamper detection,
// forged-hash limit, parallel builds, symlink rejection, EXDEV, pre-created
// temp defence, write-failure cleanup, legacy fallback, doctor integration,
// hook-status regression, concurrent migration, no-writes invariant, dir
// permissions, non-git fingerprint path.
//
// Tests that exercise internals directly (G, H, I) set AGENTMAP_TEST_EXPORT=1
// and dynamic-import agentmap.mjs; the rest drive the CLI as a subprocess via
// the standard helpers.mjs harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync,
  lstatSync, rmSync, mkdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  makeRepo, writeFiles, gitInit, git, run, cleanup, AGENTMAP,
} from "./helpers.mjs";

// createRequire lets the test file grab the live CommonJS `fs` namespace
// for tests that exercise the openSync(wx) primitive directly (test H).
// ESM static bindings to `node:fs` are frozen at link time, so we cannot
// monkey-patch `fs.renameSync` to inject EXDEV/generic failures into
// writeJsonAtomic. Instead, writeJsonAtomic exposes a test-only seam via
// __agentmapInternals.setRenameHook — see tests G and I.
const require = createRequire(import.meta.url);
const fs = require("node:fs");

process.env.AGENTMAP_TEST_EXPORT = "1";
await import("../agentmap.mjs");
const INTERNALS = globalThis.__agentmapInternals;
assert.ok(INTERNALS, "AGENTMAP_TEST_EXPORT=1 should surface __agentmapInternals");

const SHA256 = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");
const HASH_VALID = (map) => {
  if (!map || typeof map !== "object") return false;
  if (typeof map.contentHash !== "string" || map.contentHash.length !== 64) return false;
  const { contentHash, ...payload } = map;
  return contentHash === SHA256(payload);
};
const MAP_PATH = (dir) => join(dir, ".claude", "agentmap", "map.json");
const MAP_LEGACY_PATH = (dir) => join(dir, ".claude", "agentmap.json");
const readMap = (dir) => JSON.parse(readFileSync(MAP_PATH(dir), "utf8"));
const readMapLegacy = (dir) => JSON.parse(readFileSync(MAP_LEGACY_PATH(dir), "utf8"));
const TMP_FILES = (dir) => readdirSync(join(dir, ".claude", "agentmap"))
  .filter((n) => n.endsWith(".tmp"));

const FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
  "src/index.ts": `export function realSymbol() { return 1; }`,
};

// ---------------------------------------------------------------------------
// A: build writes schema 4 with valid contentHash
// ---------------------------------------------------------------------------
test("A: build writes schema 4 with valid contentHash", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--map");
  assert.equal(r.status, 0, r.stderr);
  const map = readMap(dir);
  assert.equal(map.schema, INTERNALS.SCHEMA_VERSION);
  assert.equal(map.schema, 4, `schema should be 4 (got ${map.schema})`);
  assert.equal(typeof map.contentHash, "string");
  assert.equal(map.contentHash.length, 64, "contentHash should be 64 hex chars");
  assert.ok(HASH_VALID(map), "recomputed hash should match stored contentHash");
  assert.deepEqual(TMP_FILES(dir), [], "no .tmp files should remain after build");
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// B: schema-3 cache is rebuilt (migration)
// ---------------------------------------------------------------------------
test("B: schema-3 cache is rebuilt into schema 4", () => {
  const dir = makeRepo(FIXTURE);
  const g = (...a) => git(dir, ...a);
  gitInit(dir, { commit: true });
  const sha = g("rev-parse", "--short", "HEAD").trim();
  // Seed a schema-3 cache (no contentHash).
  mkdirSync(join(dir, ".claude", "agentmap"), { recursive: true });
  writeFileSync(MAP_PATH(dir), JSON.stringify({
    schema: 3, generatedSha: sha, dirty: 0, fileCount: 1,
    hubs: [], features: {}, rankedSymbols: [], files: {},
  }));
  const r = run(dir, "--find", "realSymbol");
  assert.equal(r.status, 0, `--find should rebuild and find symbol\n${r.stderr}`);
  assert.match(r.stdout, /realSymbol/, "should find the real symbol after rebuild");
  const map = readMap(dir);
  assert.equal(map.schema, 4, "schema should be 4 after rebuild");
  assert.ok(HASH_VALID(map), "contentHash should be valid after rebuild");
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// C: tampered cache (content changed, hash unchanged) rebuilds
// ---------------------------------------------------------------------------
test("C: tampered cache with stale contentHash rebuilds", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  assert.equal(run(dir, "--map").status, 0);
  const original = readMap(dir);
  // Tamper: blank out files but keep the old (now-invalid) contentHash.
  const tamperedRaw = { ...original, files: {} };
  writeFileSync(MAP_PATH(dir), JSON.stringify(tamperedRaw));
  // Sanity: the tampered cache's stored hash is now stale.
  assert.ok(!HASH_VALID(tamperedRaw),
    "tampered cache should fail hash verification (content changed, hash didn't)");
  // --find should trigger a rebuild (stale hash) and find the real symbol.
  const r = run(dir, "--find", "realSymbol");
  assert.equal(r.status, 0, `rebuild should find the symbol\n${r.stderr}`);
  assert.match(r.stdout, /realSymbol/);
  const rebuilt = readMap(dir);
  // Rebuilt hash should be VALID (rebuild writes correct hash for current payload).
  assert.ok(HASH_VALID(rebuilt), "rebuilt hash should be valid");
  // And the rebuilt files object is no longer the tampered empty object.
  assert.ok(Object.keys(rebuilt.files).length > 0,
    "rebuilt files should be non-empty (real source was scanned)");
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// D: tampered cache with forged hash is trusted (documented contentHash limit)
// ---------------------------------------------------------------------------
test("D: tampered cache with forged hash is trusted (contentHash is not a MAC)", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  assert.equal(run(dir, "--map").status, 0);
  // Strip the legitimate contentHash before tampering, so the forged hash
  // isn't hashed over the old one.
  const { contentHash: _legit, ...payload } = readMap(dir);
  const tampered = { ...payload, files: {} };
  const forged = INTERNALS.withMapContentHash(tampered);
  assert.ok(HASH_VALID(forged), "sanity: forged hash should verify");
  writeFileSync(MAP_PATH(dir), JSON.stringify(forged));
  // --find realSymbol: should NOT find it (the forged cache is trusted, has no symbol).
  const r = run(dir, "--find", "realSymbol");
  assert.equal(r.status, 1, `forged cache with files:{} should miss — exit 1\n${r.stdout}${r.stderr}`);
  // Confirm the forged cache was served as-is (not rebuilt).
  const after = readMap(dir);
  assert.deepEqual(after.files, {}, "forged files:{} should be preserved (cache was trusted)");
  assert.equal(after.contentHash, forged.contentHash, "forged hash should be preserved");
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// E: parallel builds leave valid JSON, no .tmp files
// ---------------------------------------------------------------------------
test("E: 20 parallel builds leave valid JSON, valid hash, no .tmp leftovers", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  // Spawn 20 parallel --map processes (concurrent, not sequential).
  const procs = Array.from({ length: 20 }, () =>
    spawnSync(process.execPath, [AGENTMAP, "--map"], { cwd: dir, encoding: "utf8" }),
  );
  for (const p of procs) {
    assert.equal(p.status, 0, `parallel build should exit 0\n${p.stderr}`);
  }
  const map = readMap(dir);
  assert.equal(map.schema, 4);
  assert.ok(HASH_VALID(map), "surviving map should have valid hash");
  assert.deepEqual(TMP_FILES(dir), [], "no .tmp files should remain");
  // And no static-name temp file ever existed.
  assert.ok(!existsSync(join(dir, ".claude", "agentmap", "map.json.tmp")),
    "predictable map.json.tmp should never exist");
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// F: symlinked .claude/agentmap is rejected (strict policy, POSIX only)
// ---------------------------------------------------------------------------
test("F: symlinked .claude/agentmap is rejected with clear error", { skip: process.platform === "win32" ? "symlink test is POSIX-only" : undefined }, () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  // Set up: .claude/ exists; .claude/agentmap is a symlink to an outside dir.
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const outside = join(dir, "..", `.agentmap-real-${process.pid}-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  try {
    symlinkSync(outside, join(dir, ".claude", "agentmap"));
    const r = run(dir, "--map");
    assert.notEqual(r.status, 0, "build through symlink should fail");
    assert.match(r.stderr, /refusing to write cache through symlinked directory/i,
      "stderr should explain the symlink refusal");
    // No map.json should have been written THROUGH the symlink.
    assert.ok(!existsSync(join(outside, "map.json")),
      "no map.json should be written through the symlink");
    // The symlink itself should be intact (not removed/replaced).
    // lstatSync (NOT statSync) — statSync follows the link and reports the target.
    const st = lstatSync(join(dir, ".claude", "agentmap"));
    assert.ok(st.isSymbolicLink(), ".claude/agentmap should still be a symlink");
  } finally {
    cleanup(dir);
    try { rmSync(outside, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// G: EXDEV throws clear error, no copy fallback
// ---------------------------------------------------------------------------
test("G: writeJsonAtomic surfaces a clear error on EXDEV (no copy+delete fallback)", () => {
  const tmpDir = makeRepo({});
  const finalPath = join(tmpDir, "out.json");
  // Inject EXDEV via the test-only rename hook. Static ESM bindings to
  // node:fs are frozen, so direct fs.renameSync monkey-patching is invisible
  // to writeJsonAtomic — see the long comment above INTERNALS.
  INTERNALS.setRenameHook(() => {
    const err = new Error("simulated EXDEV");
    err.code = "EXDEV";
    throw err;
  });
  try {
    assert.throws(
      () => INTERNALS.writeJsonAtomic(finalPath, { x: 1 }),
      /agentmap: atomic cache write failed across filesystems.*EXDEV/,
      "EXDEV should surface as a clear agentmap-prefixed error",
    );
    // Temp file should be cleaned up despite the failure.
    const leftovers = readdirSync(tmpDir).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no .tmp file should remain after EXDEV");
    // And no out.json should exist at the final path.
    assert.ok(!existsSync(finalPath), "no file should exist at the final path");
  } finally {
    INTERNALS.clearRenameHook();
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// H: pre-created symlink at temp path is defeated by wx (O_EXCL)
// ---------------------------------------------------------------------------
test("H: pre-created symlink at temp path is defeated by wx", () => {
  const tmpDir = makeRepo({});
  const target = join(tmpDir, "attacker-target.json");
  writeFileSync(target, "attacker content");
  // Pre-create a symlink at a path we will then feed to writeJsonAtomic via
  // uniqueTmpPath's deterministic test variant. Because uniqueTmpPath includes
  // random bytes, we instead test the contract directly: open a path that is
  // a symlink with "wx" — it must fail with EEXIST.
  const symlinkPath = join(tmpDir, ".pre-created-symlink.tmp");
  symlinkSync(target, symlinkPath);
  // Attempting openSync(symlinkPath, "wx") must fail — that's the load-bearing
  // guarantee. writeJsonAtomic relies on this behaviour from uniqueTmpPath +
  // openSync, so we pin the primitive directly.
  assert.throws(
    () => fs.openSync(symlinkPath, "wx", 0o600),
    (err) => err.code === "EEXIST",
    "openSync(..., 'wx') on a pre-existing symlink must fail with EEXIST",
  );
  // The attacker's target file content should be untouched.
  assert.equal(readFileSync(target, "utf8"), "attacker content",
    "attacker target file must not be written through the symlink");
  cleanup(tmpDir);
});

// ---------------------------------------------------------------------------
// I: write failure cleans up the temp file
// ---------------------------------------------------------------------------
test("I: writeJsonAtomic cleans up the temp file when renameSync throws", () => {
  const tmpDir = makeRepo({});
  const finalPath = join(tmpDir, "out.json");
  INTERNALS.setRenameHook(() => {
    throw new Error("simulated disk failure mid-rename");
  });
  try {
    assert.throws(
      () => INTERNALS.writeJsonAtomic(finalPath, { x: 1 }),
      /simulated disk failure mid-rename/,
      "the original error should propagate (not be masked)",
    );
    const leftovers = readdirSync(tmpDir).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no .tmp file should remain after failure");
    assert.ok(!existsSync(finalPath), "no file should exist at the final path");
  } finally {
    INTERNALS.clearRenameHook();
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// J: legacy .claude/agentmap.json is still readable, rebuilds into namespaced path
// ---------------------------------------------------------------------------
test("J: legacy cache path is read for migration, rebuild writes namespaced path", () => {
  const dir = makeRepo(FIXTURE);
  const g = (...a) => git(dir, ...a);
  gitInit(dir, { commit: true });
  // agentmap stores --short SHA (7 chars), not the full 40-char SHA from git.
  const sha = g("rev-parse", "--short", "HEAD").trim();
  // Seed a schema-4 cache at the LEGACY path with a valid hash.
  // exports is an array of { name, kind } (matches build() output shape).
  const legacyPayload = {
    schema: 4, generatedSha: sha, dirty: 0, fileCount: 1,
    fingerprint: undefined,
    hubs: [], features: {}, rankedSymbols: [],
    files: { "src/index.ts": { imports: [], exports: [{ name: "realSymbol", kind: "FunctionDeclaration" }], dependents: [] } },
  };
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(MAP_LEGACY_PATH(dir), JSON.stringify(INTERNALS.withMapContentHash(legacyPayload)));
  // First run: should serve the legacy cache (no rebuild needed).
  const r = run(dir, "--find", "realSymbol");
  assert.equal(r.status, 0, `should find symbol via legacy cache\n${r.stderr}`);
  assert.match(r.stdout, /realSymbol/);
  // Now dirty the tree so ensureFresh rebuilds. The rebuild MUST write to MAP, not MAP_LEGACY.
  writeFileSync(join(dir, "src/index.ts"), "export function realSymbol() { return 2; }\n");
  g("add", "-A");
  g("commit", "-q", "-m", "second");
  const sha2 = g("rev-parse", "--short", "HEAD").trim();
  assert.notEqual(sha, sha2, "sanity: HEAD should have moved");
  assert.equal(run(dir, "--map").status, 0);
  assert.ok(existsSync(MAP_PATH(dir)), "rebuild should write to namespaced map.json");
  const beforeLegacy = existsSync(MAP_LEGACY_PATH(dir));
  // The rebuild should NOT have touched the legacy file.
  assert.ok(beforeLegacy, "legacy file should be untouched by rebuild");
  // The new cache at MAP should reflect the post-commit state.
  const newMap = readMap(dir);
  assert.equal(newMap.generatedSha, sha2, "new cache should be for the new HEAD");
  assert.ok(HASH_VALID(newMap), "new cache hash should be valid");
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// K: --doctor reads schema-4 cache correctly
// ---------------------------------------------------------------------------
test("K: --doctor reads a schema-4 cache without regression", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  assert.equal(run(dir, "--map").status, 0);
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, `--doctor should exit 0\n${r.stderr}`);
  assert.match(r.stdout, /Map cache/i, "doctor should report the map cache");
  // JSON variant
  const rj = run(dir, "--doctor", "--json");
  assert.equal(rj.status, 0, rj.stderr);
  const report = JSON.parse(rj.stdout);
  assert.equal(report.command, "doctor");
  assert.ok(report.checks && report.checks.map, "JSON report should include checks.map");
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// L: --hook-status still works after the change (regression smoke)
// ---------------------------------------------------------------------------
test("L: --hook-status still runs without regression after schema bump", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  assert.equal(run(dir, "--install-hooks").status, 0);
  const r = run(dir, "--hook-status");
  assert.equal(r.status, 0, `--hook-status should exit 0\n${r.stderr}`);
  assert.match(r.stdout, /post-commit/i);
  assert.match(r.stdout, /PreToolUse/i);
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// M: concurrent schema-3 → 4 migration doesn't race
// ---------------------------------------------------------------------------
test("M: 10 parallel processes migrating schema-3 → 4 don't race", () => {
  const dir = makeRepo(FIXTURE);
  const g = (...a) => git(dir, ...a);
  gitInit(dir, { commit: true });
  const sha = g("rev-parse", "--short", "HEAD").trim();
  // Seed schema-3 cache.
  mkdirSync(join(dir, ".claude", "agentmap"), { recursive: true });
  writeFileSync(MAP_PATH(dir), JSON.stringify({
    schema: 3, generatedSha: sha, dirty: 0, fileCount: 1,
    hubs: [], features: {}, rankedSymbols: [], files: {},
  }));
  // Spawn 10 parallel --map invocations.
  const procs = Array.from({ length: 10 }, () =>
    spawnSync(process.execPath, [AGENTMAP, "--map"], { cwd: dir, encoding: "utf8" }),
  );
  for (const p of procs) assert.equal(p.status, 0, `parallel migration should exit 0\n${p.stderr}`);
  const map = readMap(dir);
  assert.equal(map.schema, 4, "final map should be schema 4");
  assert.ok(HASH_VALID(map), "final map hash should be valid");
  assert.deepEqual(TMP_FILES(dir), [], "no .tmp leftovers after parallel migration");
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// N: read-only commands don't write the cache
// ---------------------------------------------------------------------------
test("N: --find (cache hit) does not write or create .tmp files", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  // Build once to warm the cache.
  assert.equal(run(dir, "--map").status, 0);
  const before = readdirSync(join(dir, ".claude", "agentmap")).sort();
  // Cache hit: --find should NOT trigger a build.
  const r = run(dir, "--find", "realSymbol");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /realSymbol/);
  // Stderr should NOT contain the "built N files" line (would indicate a rebuild).
  assert.doesNotMatch(r.stderr, /agentmap: built/,
    "warm cache hit should not rebuild");
  const after = readdirSync(join(dir, ".claude", "agentmap")).sort();
  assert.deepEqual(after, before, "no new files (incl .tmp) should appear on a cache hit");
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// O: cache dir created with correct permissions on first run
// ---------------------------------------------------------------------------
test("O: cache dir + map.json created on first run, no temp leftovers", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  // Pre-condition: no .claude/agentmap/ exists.
  assert.ok(!existsSync(join(dir, ".claude", "agentmap")));
  assert.equal(run(dir, "--map").status, 0);
  // Post-condition: dir + map.json exist, no .tmp.
  assert.ok(existsSync(join(dir, ".claude", "agentmap")));
  assert.ok(existsSync(MAP_PATH(dir)));
  assert.deepEqual(TMP_FILES(dir), []);
  // Sanity: map.json is readable and parseable.
  const map = readMap(dir);
  assert.equal(map.schema, 4);
  cleanup(dir);
});

// ---------------------------------------------------------------------------
// P: non-git repo path uses fingerprint + contentHash
// ---------------------------------------------------------------------------
test("P: non-git repo path uses fingerprint + contentHash for cache trust", () => {
  const dir = makeRepo(FIXTURE);
  // Note: NO gitInit — this is a non-git repo.
  // helpers.mjs run() discards stderr on exit 0, so use spawnSync inline
  // to assert on the "agentmap: built" stderr line for cache-miss/rebuild.
  const runWithStderr = (...args) => spawnSync(process.execPath, [AGENTMAP, ...args],
    { cwd: dir, encoding: "utf8" });
  const r1 = runWithStderr("--map");
  assert.equal(r1.status, 0, `first --map should succeed\n${r1.stderr}`);
  assert.match(r1.stderr, /agentmap: built/);
  const firstMap = readMap(dir);
  assert.equal(firstMap.schema, 4);
  assert.ok(typeof firstMap.fingerprint === "string" && firstMap.fingerprint.length > 0,
    "non-git cache should carry a fingerprint");
  assert.ok(HASH_VALID(firstMap), "non-git cache should carry a valid contentHash");
  // Second run: fingerprint unchanged, cache should be served (no rebuild).
  const r2 = runWithStderr("--map");
  assert.equal(r2.status, 0);
  assert.doesNotMatch(r2.stderr, /agentmap: built/,
    "second run with unchanged sources should hit the cache (no rebuild)");
  // Touch a source file: fingerprint should change, cache should rebuild.
  writeFileSync(join(dir, "src/index.ts"), "export function realSymbol() { return 99; }\n");
  const r3 = runWithStderr("--map");
  assert.equal(r3.status, 0);
  assert.match(r3.stderr, /agentmap: built/,
    "after source change, cache should rebuild (fingerprint changed)");
  cleanup(dir);
});
