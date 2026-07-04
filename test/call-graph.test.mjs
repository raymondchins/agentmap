// SPDX-License-Identifier: MIT
// ============================================================================
//  Compiler-accurate call graph — SYMBOL-LEVEL blast radius (--callers).
//
//  Answers "who CALLS target()" from the actual TS language-service reference
//  walk (ts-morph findReferencesAsNodes), NOT a tree-sitter / name-grep heuristic.
//  Invariants pinned here:
//    • real call sites are reported WITH file:line + enclosing caller,
//    • a TYPE-position mention / re-export / bare value reference is NOT a call,
//    • a same-named LOCAL in another file is a DIFFERENT symbol, never mis-attributed
//      (the compiler-accuracy proof a tree-sitter tool can't make),
//    • a name defined in 2+ files is reported AMBIGUOUS (never silently unioned),
//    • resolution is LAZY: normal commands never emit call-graph data.
//
//  Run: node --test test/call-graph.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// One exported `target`, two real callers (B, C), one type-only/re-export
// non-caller (D), and a decoy file with its OWN private `target` (name clash).
function callGraphRepo() {
  return {
    "src/target.ts": "export function target() { return 42; }\n",

    // B: imports and INVOKES target() in a function body → a real call site.
    "src/callerB.ts":
      'import { target } from "./target";\n' +
      "export function runB() {\n" +
      "  return target();\n" +
      "}\n",

    // C: also imports and INVOKES target().
    "src/callerC.ts":
      'import { target } from "./target";\n' +
      "export function runC() {\n" +
      "  const v = target();\n" +
      "  return v + 1;\n" +
      "}\n",

    // D: uses target ONLY in a type position and RE-EXPORTS it — never invokes it.
    // Must NOT be a caller (the heuristic trap a real reference walk avoids).
    "src/typeonly.ts":
      'import { target } from "./target";\n' +
      "export type TargetFn = typeof target;\n" +
      'export { target } from "./target";\n',

    // Decoy: a DIFFERENT symbol that happens to share the name `target`. A
    // name-grep would wrongly attribute this call; the type checker knows better.
    "src/decoy.ts":
      "function target() { return -1; }\n" +
      "export function runDecoy() {\n" +
      "  return target();\n" +
      "}\n",
  };
}

function callers(dir, symbol = "target", ...extra) {
  const r = run(dir, "--callers", symbol, ...extra, "--json");
  let o;
  try { o = JSON.parse(r.stdout); }
  catch { assert.fail(`--callers stdout was not a single JSON object:\n${r.stdout}\n${r.stderr}`); }
  return { o, status: r.status };
}
const fileset = (o) => new Set((o.callers || []).map((c) => c.file));

test("--callers reports the real call sites (B, C) with file:line + caller", () => {
  const dir = makeRepo(callGraphRepo());
  try {
    gitInit(dir, { commit: true });
    const { o } = callers(dir);
    assert.equal(o.command, "callers", `wrong discriminator (o=${JSON.stringify(o)})`);
    assert.equal(o.query, "target");
    assert.equal(o.file, "src/target.ts", "owner file must be the definition");

    const files = fileset(o);
    assert.ok(files.has("src/callerB.ts"), `B must be a caller (callers=${JSON.stringify(o.callers)})`);
    assert.ok(files.has("src/callerC.ts"), `C must be a caller (callers=${JSON.stringify(o.callers)})`);

    const b = o.callers.find((c) => c.file === "src/callerB.ts");
    assert.equal(typeof b.line, "number", `B caller must carry a numeric line (b=${JSON.stringify(b)})`);
    assert.ok(b.line > 0, "line is 1-based positive");
    assert.equal(b.caller, "runB", `enclosing caller must resolve (b=${JSON.stringify(b)})`);
  } finally { cleanup(dir); }
});

test("--callers EXCLUDES a type-position mention / re-export (D is not a caller)", () => {
  const dir = makeRepo(callGraphRepo());
  try {
    gitInit(dir, { commit: true });
    const { o } = callers(dir);
    assert.ok(
      !fileset(o).has("src/typeonly.ts"),
      `'typeof target' + re-export must NOT count as a call (callers=${JSON.stringify(o.callers)})`,
    );
  } finally { cleanup(dir); }
});

test("COMPILER-ACCURACY: a same-named LOCAL target in another file is NOT confused for the exported one", () => {
  const dir = makeRepo(callGraphRepo());
  try {
    gitInit(dir, { commit: true });
    const { o } = callers(dir);
    assert.ok(
      !fileset(o).has("src/decoy.ts"),
      `a private same-named target() is a distinct symbol — must not be attributed (callers=${JSON.stringify(o.callers)})`,
    );
  } finally { cleanup(dir); }
});

test("--callers reports EXACTLY the two real callers (no phantoms)", () => {
  const dir = makeRepo(callGraphRepo());
  try {
    gitInit(dir, { commit: true });
    const { o } = callers(dir);
    assert.equal(o.total, 2, `expected exactly 2 call sites (callers=${JSON.stringify(o.callers)})`);
    assert.deepEqual([...fileset(o)].sort(), ["src/callerB.ts", "src/callerC.ts"]);
  } finally { cleanup(dir); }
});

test("a bare value reference (const x = target) is NOT a call", () => {
  const repo = callGraphRepo();
  repo["src/valueref.ts"] =
    'import { target } from "./target";\n' +
    "export const held = target;\n"; // captures the value, never invokes
  const dir = makeRepo(repo);
  try {
    gitInit(dir, { commit: true });
    const { o } = callers(dir);
    assert.ok(!fileset(o).has("src/valueref.ts"), `a value reference must not count as a call (callers=${JSON.stringify(o.callers)})`);
    assert.equal(o.total, 2, "still exactly the two real invocations");
  } finally { cleanup(dir); }
});

test("a NON-exported top-level helper is a queryable call-graph target", () => {
  const dir = makeRepo({
    "src/priv.ts":
      "function helper() { return 1; }\n" + // private, top-level
      "export function pub() {\n" +
      "  const a = helper();\n" + // line 3
      "  const b = helper();\n" + // line 4
      "  return a + b;\n" +
      "}\n",
  });
  try {
    gitInit(dir, { commit: true });
    const { o } = callers(dir, "helper");
    assert.equal(o.file, "src/priv.ts");
    assert.equal(o.total, 2, `two distinct call lines expected (callers=${JSON.stringify(o.callers)})`);
    assert.ok(o.callers.every((c) => c.caller === "pub"), "both call sites are inside pub()");
  } finally { cleanup(dir); }
});

test("a name defined in 2+ files is AMBIGUOUS (never silently unioned); --in disambiguates", () => {
  const dir = makeRepo({
    "src/a.ts": "export function target() { return 1; }\n",
    "src/b.ts": "export function target() { return 2; }\n",
    "src/useA.ts": 'import { target } from "./a";\nexport function ua() { return target(); }\n',
  });
  try {
    gitInit(dir, { commit: true });
    const { o, status } = callers(dir);
    assert.equal(status, 1, "ambiguous resolution exits 1");
    assert.equal(o.error, "ambiguous", `expected ambiguous (o=${JSON.stringify(o)})`);
    assert.deepEqual([...o.candidates].sort(), ["src/a.ts", "src/b.ts"]);

    // --in narrows to exactly one definition; its callers are compiler-resolved.
    const narrowed = callers(dir, "target", "--in", "a.ts");
    assert.equal(narrowed.o.file, "src/a.ts", `--in must pick src/a.ts (o=${JSON.stringify(narrowed.o)})`);
    assert.ok(fileset(narrowed.o).has("src/useA.ts"), "useA calls a.ts's target");
  } finally { cleanup(dir); }
});

test("an unknown symbol is a clean no-match (exit 1), not a crash", () => {
  const dir = makeRepo(callGraphRepo());
  try {
    gitInit(dir, { commit: true });
    const { o, status } = callers(dir, "doesNotExist");
    assert.equal(status, 1);
    assert.equal(o.error, "no match", `expected no match (o=${JSON.stringify(o)})`);
  } finally { cleanup(dir); }
});

test("LAZY: normal commands never emit call-graph data (fast path untouched)", () => {
  const dir = makeRepo(callGraphRepo());
  try {
    gitInit(dir, { commit: true });
    for (const args of [["--json"], ["--map", "--json"], ["--find", "target", "--json"]]) {
      const o = JSON.parse(run(dir, ...args).stdout);
      assert.ok(!("callers" in o) && !("callGraph" in o), `${args.join(" ")} must not embed a call graph (o=${JSON.stringify(o)})`);
    }
  } finally { cleanup(dir); }
});

test("--callers with no symbol is a usage error (exit 2)", () => {
  const dir = makeRepo(callGraphRepo());
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--callers");
    assert.equal(r.status, 2, `missing arg must exit 2 (stderr=${r.stderr})`);
  } finally { cleanup(dir); }
});
