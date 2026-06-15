// SPDX-License-Identifier: MIT
// Contract #4 — exit-code contract + --help/--version.
//   0 = success / match / intentional build|help|version
//   1 = a query returned ZERO results (--any/--find/--relates/--feature, no match)
//   2 = usage error (unknown flag, missing required arg)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
  "src/index.ts": `export function realSymbol() { return 1; }`,
};

test("--find with no match exits 1", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--find", "ZZZNOPE");
  assert.equal(r.status, 1, `expected exit 1 for no-match --find, got ${r.status}\n${r.stdout}${r.stderr}`);
  cleanup(dir);
});

test("--find with a match exits 0", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--find", "realSymbol");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /realSymbol/);
  cleanup(dir);
});

test("--any with zero results exits 1", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", "totally_absent_zzqq_token");
  assert.equal(r.status, 1, `expected exit 1 for empty --any, got ${r.status}`);
  cleanup(dir);
});

test("--feature with no match exits 1", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--feature", "nonexistentfeature");
  assert.equal(r.status, 1, `expected exit 1 for unknown feature, got ${r.status}`);
  cleanup(dir);
});

test("--relates to a non-resolvable file exits 1", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "no_such_file_zz.ts");
  assert.equal(r.status, 1, `expected exit 1 for unresolved --relates, got ${r.status}`);
  cleanup(dir);
});

test("unknown flag exits 2 with a usage hint on stderr (not a silent rebuild)", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--nope");
  assert.equal(r.status, 2, `expected exit 2 for unknown flag, got ${r.status}`);
  assert.match(r.stderr, /unknown flag/i, "expected 'unknown flag' on stderr");
  assert.match(r.stderr, /--nope/, "expected the offending flag echoed");
  cleanup(dir);
});

test("--help exits 0 and lists the flag surface on stdout", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--help");
  assert.equal(r.status, 0, `--help should exit 0, got ${r.status}`);
  // Usage block should enumerate the primary flags.
  for (const flag of ["--any", "--find", "--relates", "--map", "--hubs", "--mcp", "--install-hooks", "--hook-status", "--doctor"]) {
    assert.ok(r.stdout.includes(flag), `--help missing mention of ${flag}`);
  }
  cleanup(dir);
});

test("-h is an alias for --help (exit 0)", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "-h");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--any/);
  cleanup(dir);
});

test("--version prints package.json version and exits 0", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--version");
  assert.equal(r.status, 0, `--version should exit 0, got ${r.status}`);
  assert.match(r.stdout.trim(), new RegExp(PKG.version.replace(/\./g, "\\.")), `expected version ${PKG.version} in output`);
  cleanup(dir);
});

test("-v is an alias for --version (exit 0, prints version)", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "-v");
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), new RegExp(PKG.version.replace(/\./g, "\\.")));
  cleanup(dir);
});
