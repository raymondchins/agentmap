// SPDX-License-Identifier: MIT
// ============================================================================
//  Compiler-accurate OUTGOING call graph — `--calls <symbol>`.
//
//  "What in-project symbols does this symbol INVOKE?" — the callee of each
//  call/construct site inside the symbol's body, resolved by the TS language
//  service (ts-morph `getDefinitionNodes` = go-to-definition, which follows an
//  imported binding THROUGH to the real declaration). Invariants pinned here:
//    • same-file + imported callees resolve to their real definition files,
//    • node_modules / TS built-ins (JSON, console, Array.map) are excluded,
//    • a bare value reference is not a call; a callee invoked twice is one edge,
//    • member calls + `new X()` resolve; dynamic/higher-order callees are skipped
//      without crashing (the honest static-analysis limit),
//    • owner resolution (ambiguous / --in / no-match) mirrors --callers.
//
//  Run: node --test test/calls.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// orchestrate() (exported) calls a same-file local (stepA), an imported function
// (stepB from ./steps), an external builtin (JSON.stringify), and holds stepA as a
// bare value (not a call). A decoy file has its OWN private stepB (name clash).
function repo() {
  return {
    "src/steps.ts": "export function stepB() { return 2; }\n",
    "src/orch.ts":
      'import { stepB } from "./steps";\n' +
      "function stepA() { return 1; }\n" +
      "export function orchestrate() {\n" +
      "  const held = stepA;\n" + // value reference — NOT a call
      "  stepA();\n" + // call
      "  stepA();\n" + // called twice → one edge
      "  const s = stepB();\n" + // imported call
      "  return JSON.stringify([held, s]);\n" + // external — excluded
      "}\n",
    // Decoy: a private same-named stepB. orchestrate imports from ./steps, so its
    // stepB() must resolve to src/steps.ts, NEVER src/decoy.ts.
    "src/decoy.ts":
      "function stepB() { return -1; }\n" +
      "export function runDecoy() { return stepB(); }\n",
  };
}

function calls(dir, symbol = "orchestrate", ...extra) {
  const r = run(dir, "--calls", symbol, ...extra, "--json");
  let o;
  try { o = JSON.parse(r.stdout); }
  catch { assert.fail(`--calls stdout was not a single JSON object:\n${r.stdout}\n${r.stderr}`); }
  return { o, status: r.status };
}
const names = (o) => new Set((o.calls || []).map((c) => c.name));
const byName = (o, n) => (o.calls || []).find((c) => c.name === n);

test("--calls resolves same-file + imported callees to their real definition files", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const { o } = calls(dir);
    assert.equal(o.command, "calls", `wrong discriminator (o=${JSON.stringify(o)})`);
    assert.equal(o.query, "orchestrate");
    assert.equal(o.file, "src/orch.ts");
    assert.ok(names(o).has("stepA"), `same-file local callee (calls=${JSON.stringify(o.calls)})`);
    assert.ok(names(o).has("stepB"), `imported callee (calls=${JSON.stringify(o.calls)})`);
    assert.equal(byName(o, "stepA").file, "src/orch.ts");
    assert.equal(byName(o, "stepB").file, "src/steps.ts", "imported callee resolves to its DEFINITION file, not the import site");
  } finally { cleanup(dir); }
});

test("--calls EXCLUDES node_modules / TS built-ins (JSON.stringify is not an in-project target)", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const { o } = calls(dir);
    for (const c of o.calls) assert.ok(c.file.startsWith("src/"), `every target must be in-project (offender=${JSON.stringify(c)})`);
    assert.ok(!names(o).has("stringify"), "JSON.stringify (a lib.d.ts builtin) must be excluded");
  } finally { cleanup(dir); }
});

test("a callee invoked twice is ONE edge; a bare value reference is not a call", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const { o } = calls(dir);
    assert.deepEqual([...names(o)].sort(), ["stepA", "stepB"], `exactly {stepA, stepB} (calls=${JSON.stringify(o.calls)})`);
    assert.equal(o.total, 2, "two distinct in-project targets, deduped");
  } finally { cleanup(dir); }
});

test("COMPILER-ACCURACY: an imported callee resolves to the import's definition, not a same-named decoy", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const { o } = calls(dir);
    const b = byName(o, "stepB");
    assert.equal(b.file, "src/steps.ts", `stepB must bind to the imported def, never the decoy (b=${JSON.stringify(b)})`);
    assert.ok(!(o.calls || []).some((c) => c.file === "src/decoy.ts"), "the decoy's private stepB is a different symbol");
  } finally { cleanup(dir); }
});

test("member calls + `new X()` resolve compiler-accurately (constructor + method)", () => {
  const dir = makeRepo({
    "src/svc.ts": "export class Svc {\n  helper() { return 1; }\n}\n",
    "src/use.ts":
      'import { Svc } from "./svc";\n' +
      "export function useIt() {\n" +
      "  const s = new Svc();\n" + // constructor
      "  return s.helper() + s.helper();\n" + // member call, twice → one edge
      "}\n",
  });
  try {
    gitInit(dir, { commit: true });
    const { o } = calls(dir, "useIt");
    assert.ok(names(o).has("Svc"), `new Svc() must resolve the class (calls=${JSON.stringify(o.calls)})`);
    assert.equal(byName(o, "Svc").kind, "ClassDeclaration");
    assert.ok(names(o).has("helper"), "member call s.helper() must resolve the method");
    assert.equal(byName(o, "helper").file, "src/svc.ts");
    assert.equal(o.total, 2, "Svc + helper, member call deduped");
  } finally { cleanup(dir); }
});

test("dynamic dispatch + higher-order callees are skipped without crashing (honest limit)", () => {
  const dir = makeRepo({
    "src/dyn.ts":
      "export function dispatch(key, cb) {\n" +
      "  const table = {};\n" +
      "  table[key]();\n" + // computed member → unresolvable, skipped
      "  return cb();\n" + // higher-order param → filtered (Parameter binding)
      "}\n",
  });
  try {
    gitInit(dir, { commit: true });
    const { o } = calls(dir, "dispatch");
    assert.equal(o.command, "calls", `must not crash (o=${JSON.stringify(o)})`);
    assert.ok(Array.isArray(o.calls), "calls array present");
    assert.equal(o.total, 0, `no statically-resolvable in-project callee (calls=${JSON.stringify(o.calls)})`);
  } finally { cleanup(dir); }
});

test("owner resolution parity: no-match / ambiguous+--in / usage error mirror --callers", () => {
  // no match
  const d1 = makeRepo(repo());
  try {
    gitInit(d1, { commit: true });
    const { o, status } = calls(d1, "doesNotExist");
    assert.equal(status, 1);
    assert.equal(o.error, "no match");
  } finally { cleanup(d1); }

  // ambiguous + --in disambiguation
  const d2 = makeRepo({
    "src/leaf.ts": "export function leaf() { return 1; }\n",
    "src/a.ts": 'import { leaf } from "./leaf";\nexport function dup() { return leaf(); }\n',
    "src/b.ts": "export function dup() { return 2; }\n",
  });
  try {
    gitInit(d2, { commit: true });
    const amb = calls(d2, "dup");
    assert.equal(amb.status, 1);
    assert.equal(amb.o.error, "ambiguous");
    assert.deepEqual([...amb.o.candidates].sort(), ["src/a.ts", "src/b.ts"]);
    const narrowed = calls(d2, "dup", "--in", "a.ts");
    assert.equal(narrowed.o.file, "src/a.ts");
    assert.ok(names(narrowed.o).has("leaf"), `a.ts's dup calls leaf (calls=${JSON.stringify(narrowed.o.calls)})`);
  } finally { cleanup(d2); }

  // usage error
  const d3 = makeRepo(repo());
  try {
    gitInit(d3, { commit: true });
    assert.equal(run(d3, "--calls").status, 2, "missing symbol → exit 2");
  } finally { cleanup(d3); }
});

test("LAZY: normal commands never emit outgoing call-graph data", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    for (const args of [["--json"], ["--map", "--json"], ["--find", "orchestrate", "--json"]]) {
      const o = JSON.parse(run(dir, ...args).stdout);
      assert.ok(!("calls" in o), `${args.join(" ")} must not embed outgoing calls (o=${JSON.stringify(o)})`);
    }
  } finally { cleanup(dir); }
});
