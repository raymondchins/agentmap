// SPDX-License-Identifier: MIT
// ============================================================================
//  Batch 3 Tier 2 — true incremental dirty build. When every dirty entry is a
//  MODIFICATION of a file already in the clean-HEAD facts snapshot, agentmap
//  reparses only the changed files (against empty resolution stubs of the rest)
//  and re-runs the cheap global assembly — producing a map BYTE-IDENTICAL to a
//  full dirty rebuild. Adds/deletes/renames change the file set (key ordering +
//  importer edges) and are declined → full dirty build (still Tier-1 cached).
//
//  Every correctness test proves incremental == full by capturing map.dirty.json
//  from the incremental path and again with AGENTMAP_NO_INCREMENTAL=1 (forced
//  full) and asserting byte-equality.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo, gitInit, git, writeFiles, cleanup, AGENTMAP } from "./helpers.mjs";

const MAP_DIRTY = ".claude/agentmap/map.dirty.json";
const FACTS = ".claude/agentmap/facts.json";

// Run agentmap in `dir` with optional extra env; always capture stdout+stderr.
function runAM(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [AGENTMAP, ...args], {
    cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}
const readDirty = (dir) => readFileSync(join(dir, MAP_DIRTY), "utf8");
const wasIncremental = (r) => /\(incremental\)/.test(r.stderr);

// Prime the clean cache, apply `edits`, then assert the incremental map equals a
// forced full dirty build byte-for-byte. Returns the incremental run's stderr.
function assertIncrementalEqualsFull(dir, edits, { expectIncremental }) {
  runAM(dir, ["--hubs"]);                                 // clean prime → map.json + facts.json
  assert.ok(existsSync(join(dir, FACTS)), "clean build must persist facts.json");
  writeFiles(dir, edits);

  const rInc = runAM(dir, ["--map", "--json"]);           // default path (incremental if eligible)
  assert.equal(rInc.status, 0, rInc.stderr);
  const inc = readDirty(dir);
  rmSync(join(dir, MAP_DIRTY), { force: true });

  const rFull = runAM(dir, ["--map", "--json"], { AGENTMAP_NO_INCREMENTAL: "1" });
  assert.equal(rFull.status, 0, rFull.stderr);
  const full = readDirty(dir);

  assert.equal(inc, full, "incremental map.dirty.json must be byte-identical to a full dirty build");
  assert.equal(wasIncremental(rInc), expectIncremental,
    expectIncremental ? "expected the incremental path" : "expected a full-build fallback");
  return rInc;
}

const BASE = {
  "a.ts": "export const a = 1;\nexport default function widget() { return a; }\n",
  "b.ts": "import widget, { a } from './a';\nexport const b = a + widget();\n",
  "c.ts": "import { b } from './b';\nexport function usesB() { return b; }\n",
  "util/helper.ts": "export function help(x) { return x * 2; }\n",
};

test("modify: incremental map is byte-identical to a full dirty build, reparsing only the changed file", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    const r = assertIncrementalEqualsFull(dir,
      { "c.ts": "import { b } from './b';\nexport function usesB() { return b + 1; } // edit\n" },
      { expectIncremental: true });
    assert.match(r.stderr, /parsing 1 source files \(incremental\)/, "should reparse exactly 1 file");
  } finally { cleanup(dir); }
});

test("modify renaming a default export updates importers' resolved edges (byte-identical)", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    // a.ts default export changes name widget → gadget; b.ts imports it as default
    // and must resolve to the NEW name in the incremental map, same as a full build.
    assertIncrementalEqualsFull(dir,
      { "a.ts": "export const a = 1;\nexport default function gadget() { return a; }\n" },
      { expectIncremental: true });
  } finally { cleanup(dir); }
});

test("modify adding a new import edge to an existing file (byte-identical)", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    assertIncrementalEqualsFull(dir,
      { "c.ts": "import { b } from './b';\nimport { help } from './util/helper';\nexport function usesB() { return help(b); }\n" },
      { expectIncremental: true });
  } finally { cleanup(dir); }
});

test("modifying multiple files at once stays incremental and byte-identical", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    const r = assertIncrementalEqualsFull(dir, {
      "b.ts": "import widget, { a } from './a';\nexport const b = a + widget() + 2; // e1\n",
      "c.ts": "import { b } from './b';\nexport function usesB() { return b - 1; } // e2\n",
    }, { expectIncremental: true });
    assert.match(r.stderr, /parsing 2 source files \(incremental\)/, "should reparse exactly 2 files");
  } finally { cleanup(dir); }
});

test("adding a new file falls back to a full build and stays byte-identical", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    assertIncrementalEqualsFull(dir,
      { "d.ts": "import { a } from './a';\nexport const d = a + 100;\n" },
      { expectIncremental: false });
  } finally { cleanup(dir); }
});

test("deleting a file falls back to a full build and stays byte-identical", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    runAM(dir, ["--hubs"]);                               // clean prime
    rmSync(join(dir, "util/helper.ts"), { force: true }); // delete
    const rInc = runAM(dir, ["--map", "--json"]);
    const inc = readDirty(dir); rmSync(join(dir, MAP_DIRTY), { force: true });
    const rFull = runAM(dir, ["--map", "--json"], { AGENTMAP_NO_INCREMENTAL: "1" });
    const full = readDirty(dir);
    assert.equal(inc, full, "delete must fall back to full and match");
    assert.ok(!wasIncremental(rInc), "delete must not use the incremental path");
    assert.equal(rFull.status, 0);
  } finally { cleanup(dir); }
});

test("a renamed file falls back to a full build and stays byte-identical", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    runAM(dir, ["--hubs"]);
    git(dir, "mv", "util/helper.ts", "util/helper2.ts");
    const rInc = runAM(dir, ["--map", "--json"]);
    const inc = readDirty(dir); rmSync(join(dir, MAP_DIRTY), { force: true });
    const rFull = runAM(dir, ["--map", "--json"], { AGENTMAP_NO_INCREMENTAL: "1" });
    const full = readDirty(dir);
    assert.equal(inc, full, "rename must fall back to full and match");
    assert.ok(!wasIncremental(rInc), "rename must not use the incremental path");
  } finally { cleanup(dir); }
});

// --- Re-export barrels: a file's `exports` list transitively resolves through
// `export … from` targets, which are empty stubs in incremental mode. Both
// directions must fall back to a full build and stay byte-identical.
const BARREL = {
  "lib/x.ts": "export const foo = 1;\nexport function helper() { return foo; }\n",
  "lib/barrel.ts": "export * from './x';\nexport const extra = 2;\n",
  "lib/named.ts": "export { foo as f2 } from './x';\n",
  "main.ts": "import { foo, helper, extra } from './lib/barrel';\nexport const use = foo + helper() + extra;\n",
};

test("modifying a star-barrel (export *) falls back to full and stays byte-identical", () => {
  const dir = makeRepo(BARREL);
  try {
    gitInit(dir, { commit: true });
    assertIncrementalEqualsFull(dir,
      { "lib/barrel.ts": "export * from './x';\nexport const extra = 2;\nexport const extra3 = 3;\n" },
      { expectIncremental: false });
  } finally { cleanup(dir); }
});

test("modifying a named re-export barrel falls back to full and stays byte-identical", () => {
  const dir = makeRepo(BARREL);
  try {
    gitInit(dir, { commit: true });
    assertIncrementalEqualsFull(dir,
      { "lib/named.ts": "export { foo as f2 } from './x';\n// touched\n" },
      { expectIncremental: false });
  } finally { cleanup(dir); }
});

test("modifying a file re-exported by an unchanged barrel falls back to full (reverse hazard)", () => {
  const dir = makeRepo(BARREL);
  try {
    gitInit(dir, { commit: true });
    // x.ts gains a new export; the unchanged barrel/named files re-export from it,
    // so their cached exports would go stale — must fall back to a full build.
    assertIncrementalEqualsFull(dir,
      { "lib/x.ts": "export const foo = 1;\nexport function helper() { return foo; }\nexport const bar = 9;\n" },
      { expectIncremental: false });
  } finally { cleanup(dir); }
});

test("modifying a plain consumer of a barrel stays incremental and byte-identical", () => {
  const dir = makeRepo(BARREL);
  try {
    gitInit(dir, { commit: true });
    assertIncrementalEqualsFull(dir,
      { "main.ts": "import { foo, helper, extra } from './lib/barrel';\nexport const use = foo + helper() + extra + 1;\n" },
      { expectIncremental: true });
  } finally { cleanup(dir); }
});

// --- Laundered default re-exports (no `from` clause) — found by the adversarial
// suite. `export default <ImportedIdentifier>` / `export { Imported as default }`
// resolve the exported symbol's name through another file; if ts-morph can't name
// it against the stub (kind "?"), incremental must decline. Either way the result
// must be byte-identical to a full build.
const DEFAULT_REEXPORT = {
  "src/Panel.tsx": "export default function Panel() { return null; }\nexport const panelSize = 3;\n",
  "src/Widget.tsx": "export function helperOne() { return 1; }\nexport default function Widget() { return null; }\n",
  "src/Home.tsx": "import Widget from './Widget';\nexport const Home = () => Widget();\n",
  "src/About.tsx": "import Widget from './Widget';\nexport const About = () => Widget();\n",
  "tsconfig.json": '{"compilerOptions":{"jsx":"react-jsx","baseUrl":"."}}\n',
};

test("modifying a file to `export default <imported>` stays byte-identical vs a full build", () => {
  const dir = makeRepo(DEFAULT_REEXPORT);
  try {
    gitInit(dir, { commit: true });
    assertIncrementalEqualsFull(dir,
      { "src/Widget.tsx": "import Panel from './Panel';\nexport function helperOne() { return 1; }\nexport default Panel;\n" },
      { expectIncremental: true });
  } finally { cleanup(dir); }
});

test("modifying a file to `export { imported as default }` stays byte-identical vs a full build", () => {
  const dir = makeRepo(DEFAULT_REEXPORT);
  try {
    gitInit(dir, { commit: true });
    assertIncrementalEqualsFull(dir,
      { "src/Widget.tsx": "import Panel from './Panel';\nexport function helperOne() { return 1; }\nexport { Panel as default };\n" },
      { expectIncremental: true });
  } finally { cleanup(dir); }
});

test("a repo with a NESTED tsconfig falls back to full (alias-collision safety)", () => {
  const dir = makeRepo({
    "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@shared/*":["src/shared/*"]}}}\n',
    "packages/pkg/tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@shared/*":["src/shared/*"]}}}\n',
    "src/shared/thing.ts": "export const rootThing = () => 'ROOT';\n",
    "packages/pkg/src/shared/thing.ts": "export const pkgThing = () => 'PKG';\n",
    "packages/pkg/src/consumer.ts": "import { pkgThing } from '@shared/thing';\nexport const useIt = () => pkgThing();\n",
  });
  try {
    gitInit(dir, { commit: true });
    assertIncrementalEqualsFull(dir,
      { "packages/pkg/src/consumer.ts": "import { pkgThing } from '@shared/thing';\nexport const useIt = () => pkgThing() + '!';\n" },
      { expectIncremental: false });
  } finally { cleanup(dir); }
});

test("missing facts snapshot falls back to a full build (no crash)", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    runAM(dir, ["--hubs"]);
    rmSync(join(dir, FACTS), { force: true });            // wipe the snapshot
    writeFiles(dir, { "c.ts": "import { b } from './b';\nexport const c2 = b; // edit\n" });
    const rInc = runAM(dir, ["--map", "--json"]);
    assert.equal(rInc.status, 0, rInc.stderr);
    assert.ok(!wasIncremental(rInc), "no facts snapshot ⇒ must fall back to full");
    const inc = readDirty(dir); rmSync(join(dir, MAP_DIRTY), { force: true });
    const full = (() => { runAM(dir, ["--map", "--json"], { AGENTMAP_NO_INCREMENTAL: "1" }); return readDirty(dir); })();
    assert.equal(inc, full, "fallback map must equal a full build");
  } finally { cleanup(dir); }
});
