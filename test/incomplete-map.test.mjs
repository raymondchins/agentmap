// SPDX-License-Identifier: MIT
// ============================================================================
//  Truncation accounting — a file that throws during parse must be COUNTED, not
//  just logged (agentmap.mjs, extractFacts catch + assemble's `truncation`).
//
//  The bug: a pathological file is caught per-file so one bad file can't abort the
//  build (correct), but it never reached `files[path]` — so map.json reported a
//  fileCount over the SURVIVORS with degraded:false and exit 0, while --relates /
//  --find answered confidently about a graph the file had never been in. The only
//  trace was one stderr line, which run() in helpers.mjs discards on a zero exit —
//  so the suite couldn't see it either. test/audit-fixes.test.mjs already used this
//  exact poison pill but only asserted the exit code and a survivor symbol, which is
//  why it shipped.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, runErr, runWithHome, cleanup } from "./helpers.mjs";

const MAP = join(".claude", "agentmap", "map.json");
const readMap = (d) => JSON.parse(readFileSync(join(d, MAP), "utf8"));
const readRaw = (d) => readFileSync(join(d, MAP), "utf8");

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", allowJs: true },
  include: ["src/**/*"],
});
const HEALTHY = {
  "tsconfig.json": TSCONFIG,
  "src/a.ts": `import { b } from "./b";\nexport const a = b + 1;\n`,
  "src/b.ts": `export const b = 1;\n`,
  "src/c.ts": `import { a } from "./a";\nexport const c = a;\n`,
};
// The poison pill from test/audit-fixes.test.mjs: a backtick module specifier makes
// ts-morph throw inside the per-file try. Deterministic — no timing, no stack tricks.
const POISON = { ...HEALTHY, "src/broken.ts": "import foo from `./nope`;\nexport const broken = foo;\n" };

// --- the byte-identity guard -------------------------------------------------
test("BYTE-IDENTICAL: a repo that indexes every file gains no new bytes", () => {
  const dir = makeRepo(HEALTHY);
  gitInit(dir, { commit: true });
  try {
    run(dir);
    const raw = readRaw(dir);
    assert.ok(!/incomplete|skippedCount|"skipped"|skippedTruncated/.test(raw),
      "truncation fields leaked into a map that skipped nothing");
    const m = readMap(dir);
    assert.equal(m.fileCount, 3);
    assert.equal("incomplete" in m, false);
  } finally { cleanup(dir); }
});

// --- the actual bug ----------------------------------------------------------
test("a thrown file is counted in map.json, not just written to stderr", () => {
  const dir = makeRepo(POISON);
  gitInit(dir, { commit: true });
  try {
    const r = runErr(dir);
    assert.equal(r.status, 0, "a poison-pill file must not fail the build");

    const m = readMap(dir);
    assert.equal(m.incomplete, true);
    assert.equal(m.skippedCount, 1);
    assert.deepEqual(m.skipped, [{ file: "src/broken.ts", reason: "parse-error" }]);
    assert.equal(m.fileCount, 3, "the three good files must still be indexed");
    assert.equal(m.fileCount + m.skippedCount, 4, "every source file is indexed or counted as skipped");
    assert.equal("skippedTruncated" in m, false, "1 skip is far under the cap");
    assert.match(r.stderr, /INCOMPLETE map: 1 of 4 files/);
  } finally { cleanup(dir); }
});

test("--doctor reports an incomplete map and does not call it ok", () => {
  const dir = makeRepo(POISON);
  const home = makeRepo({});
  gitInit(dir, { commit: true });
  try {
    run(dir);
    const rep = JSON.parse(runWithHome(dir, home, "--doctor", "--json").stdout);
    const mapCheck = rep.checks.map.find((c) => c.name === "map-cache");
    assert.equal(mapCheck.status, "incomplete");
    assert.match(mapCheck.detail, /missing 1 source file/);
    assert.match(mapCheck.detail, /src\/broken\.ts/, "the skipped file should be named");
    assert.notEqual(rep.overall, "ok", "a map missing files must not report overall ok");
  } finally { cleanup(dir); cleanup(home); }
});

// A truncated build must not seed the Tier-2 facts snapshot: buildIncremental()
// merges cached facts for every file it does not re-parse, so a partial snapshot
// would turn a transient parse failure into a permanent absence.
test("a truncated build does not write the incremental facts snapshot", () => {
  const dir = makeRepo(POISON);
  gitInit(dir, { commit: true });
  try {
    run(dir);
    assert.equal(readMap(dir).incomplete, true);
    const factsPath = join(dir, ".claude", "agentmap", "facts.json");
    let wrote = true;
    try { readFileSync(factsPath); } catch { wrote = false; }
    assert.equal(wrote, false, "facts.json was seeded from a build that dropped a file");
  } finally { cleanup(dir); }
});

// The healthy control for the above — proves the guard is conditional, not a
// blanket disable of the Tier-2 snapshot.
test("a complete build still writes the incremental facts snapshot", () => {
  const dir = makeRepo(HEALTHY);
  gitInit(dir, { commit: true });
  try {
    run(dir);
    assert.equal("incomplete" in readMap(dir), false);
    const facts = JSON.parse(readFileSync(join(dir, ".claude", "agentmap", "facts.json"), "utf8"));
    assert.ok(facts.facts, "facts snapshot missing on a clean complete build");
  } finally { cleanup(dir); }
});
