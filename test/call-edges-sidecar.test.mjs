// SPDX-License-Identifier: MIT
// ============================================================================
//  Call-edge sidecar (--build-edges) — a CACHE, never a second source of truth.
//
//  `--callers` has always answered from a live ts-morph reference walk: correct,
//  and ~1500ms because the type-checker's first full-program bind dominates
//  (~750ms) and is paid per query. `--build-edges` precomputes the same edges
//  once into .claude/agentmap/calledges.json so the query becomes a JSON lookup
//  (~77ms measured on a 250-file repo).
//
//  The whole design rests on ONE invariant, which is what this file pins:
//  a cached answer is BYTE-IDENTICAL to the live answer, and anything that could
//  make it otherwise (a stale key, a corrupt file, a query shape the sidecar
//  cannot represent) falls back to the live walk instead of guessing. A cache
//  that can disagree with its source is worse than no cache, so every test here
//  compares the two paths directly rather than asserting a hardcoded shape.
//
//  Run: node --test test/call-edges-sidecar.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, runErr, cleanup } from "./helpers.mjs";

const EDGES = ".claude/agentmap/calledges.json";

// A repo exercising the shapes the sidecar has to round-trip: a plain call, a
// JSX component (self-closing AND paired), a dotted `<UI.Widget />` tag, a call
// inside an anonymous .map() callback (enclosing-name resolution), and a decoy
// file with its OWN private `target` that must never be attributed.
function repo() {
  return {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { jsx: "react-jsx", moduleResolution: "bundler", module: "esnext", target: "esnext", baseUrl: "." },
    }),
    "src/target.ts": "export function target() { return 42; }\n",
    "src/Widget.tsx": "export function Widget(p: { id?: string }) { return <div>{p.id}</div>; }\n",
    "src/callers.ts":
      'import { target } from "./target";\n' +
      "export function runA() { return target(); }\n" +
      "export function runB() { const v = target(); return v + 1; }\n",
    "src/Uses.tsx":
      'import { Widget } from "./Widget";\n' +
      "export function Plain() { return <Widget />; }\n" +
      "export function Paired() { return <Widget>x</Widget>; }\n" +
      "export function Mapped({ ids }: { ids: string[] }) {\n" +
      "  return <div>{ids.map((i) => <Widget key={i} id={i} />)}</div>;\n" +
      "}\n",
    "src/Dotted.tsx":
      'import * as UI from "./Widget";\n' +
      "export function Dotted() { return <UI.Widget />; }\n",
    // Private same-named `target` — a DIFFERENT symbol. Never a caller of src/target.ts.
    "src/decoy.ts":
      "function target() { return 0; }\n" +
      "export function useDecoy() { return target(); }\n",
    // A non-function export, which every shape above lacked — and that gap is why
    // the parity assertion below could not catch the receiver bug. `db` is never
    // called; only methods ON it are. The live walk used to count `db.query()` as
    // a call site of `db` while the sidecar builder (which checks the name half)
    // did not, so the two paths disagreed and the answer depended on whether the
    // background --build-edges had finished.
    "src/db.ts": "export const db = { query() { return 1; } };\n",
    "src/useDb.ts":
      'import { db } from "./db";\n' +
      "export function readAll() { return db.query(); }\n",
  };
}

// Capture --callers twice: once served from the sidecar, once with the sidecar
// moved aside so the live walk runs. Returns [cached, live] stdout.
function bothPaths(dir, ...args) {
  const p = join(dir, EDGES);
  assert.ok(existsSync(p), "sidecar should exist before comparing paths");
  const cached = run(dir, ...args).stdout;
  const bak = `${p}.bak`;
  renameSync(p, bak);
  const live = run(dir, ...args).stdout;
  renameSync(bak, p);
  return [cached, live];
}

test("--build-edges writes a sidecar and reports what it indexed", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--build-edges", "--json");
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.command, "build-edges");
    assert.ok(out.edges > 0, `expected some edges, got ${out.edges}`);
    assert.ok(out.sites >= out.edges, "sites walked cannot be fewer than edges resolved");
    assert.ok(existsSync(join(dir, EDGES)), "sidecar file should exist");
  } finally { cleanup(dir); }
});

test("cached --callers is byte-identical to the live walk", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    for (const q of [
      ["--callers", "target", "--in", "src/target.ts"],
      ["--callers", "Widget", "--in", "src/Widget.tsx"],
      ["--callers", "target", "--in", "src/decoy.ts"],
      // Non-function export: the shape that used to make the two paths disagree.
      ["--callers", "db", "--in", "src/db.ts"],
    ]) {
      const [cached, live] = bothPaths(dir, ...q, "--json");
      assert.equal(cached, live, `sidecar diverged from live for: ${q.join(" ")}`);
    }
  } finally { cleanup(dir); }
});

test("the decoy's private target is never attributed to the exported one", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    const out = JSON.parse(run(dir, "--callers", "target", "--in", "src/target.ts", "--json").stdout);
    const files = out.callers.map((c) => c.file);
    assert.ok(!files.includes("src/decoy.ts"), `decoy leaked into callers: ${JSON.stringify(files)}`);
    assert.equal(out.total, 2, "runA + runB are the only real callers");
  } finally { cleanup(dir); }
});

test("a paired <Widget>…</Widget> counts once, and .map() callers are named", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    const out = JSON.parse(run(dir, "--callers", "Widget", "--in", "src/Widget.tsx", "--json").stdout);
    const lines = out.callers.map((c) => `${c.file}:${c.line}`);
    assert.equal(new Set(lines).size, lines.length, "closing tags must not double-count");
    const mapped = out.callers.find((c) => c.file === "src/Uses.tsx" && c.caller === "Mapped");
    assert.ok(mapped, `.map() call site should be attributed to Mapped, got ${JSON.stringify(out.callers)}`);
  } finally { cleanup(dir); }
});

test("a STALE sidecar is ignored, not served", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    const before = JSON.parse(run(dir, "--callers", "target", "--in", "src/target.ts", "--json").stdout);
    assert.equal(before.total, 2);
    // Add a third caller WITHOUT rebuilding edges. The sidecar still claims 2.
    writeFileSync(join(dir, "src/callerC.ts"),
      'import { target } from "./target";\nexport function runC() { return target(); }\n');
    const after = JSON.parse(run(dir, "--callers", "target", "--in", "src/target.ts", "--json").stdout);
    assert.equal(after.total, 3, "a stale sidecar must not mask a new call site");
  } finally { cleanup(dir); }
});

test("a CORRUPT sidecar falls back to the live walk instead of crashing", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    writeFileSync(join(dir, EDGES), "{ this is not json");
    const r = runErr(dir, "--callers", "target", "--in", "src/target.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).total, 2);
    // ...and SAYS so. Staleness is routine and stays quiet, but silently serving a
    // 20x-slower path because the cache is corrupt is undiagnosable.
    assert.match(r.stderr, /unreadable|malformed/, "a corrupt sidecar must be reported on stderr");
    // Valid JSON with the wrong shape must also fall back, and also say so.
    const r2 = runErr(dir, "--callers", "target", "--in", "src/target.ts", "--json");
    assert.equal(JSON.parse(r2.stdout).total, 2);
    assert.match(r2.stderr, /unreadable|malformed/, "a malformed sidecar must be reported too");
  } finally { cleanup(dir); }
});

// The sidecar stores BOTH ends of every edge, so the same table answers the
// opposite direction and the transitive walk — not just single-hop --callers.
// Each of these must stay byte-identical to the live walk, which is the only
// thing that makes serving them from cache legitimate.
test("--calls is served from cache, byte-identical to the live walk", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    for (const q of [
      ["--calls", "runA", "--in", "src/callers.ts"],
      ["--calls", "Mapped", "--in", "src/Uses.tsx"],
      ["--calls", "useDecoy", "--in", "src/decoy.ts"],
    ]) {
      const [cached, live] = bothPaths(dir, ...q, "--json");
      assert.equal(cached, live, `--calls diverged for: ${q.join(" ")}`);
    }
  } finally { cleanup(dir); }
});

test("--callers --depth N is served from cache, byte-identical (incl. the `via` chain)", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    for (const d of ["2", "3", "5"]) {
      const [cached, live] = bothPaths(dir, "--callers", "target", "--in", "src/target.ts", "--depth", d, "--json");
      assert.equal(cached, live, `--depth ${d} diverged`);
    }
    // `via` is user-visible provenance: file:caller:DECLARATION-line. An internal
    // dedup key leaking into it here would be invisible to a shape-only assertion.
    const j = JSON.parse(run(dir, "--callers", "target", "--in", "src/target.ts", "--depth", "2", "--json").stdout);
    for (const c of j.callers) {
      if (c.via === null) continue;
      assert.match(c.via, /^[^\s]+:[^:]+:\d+$/, `via must be file:caller:line, got ${JSON.stringify(c.via)}`);
    }
  } finally { cleanup(dir); }
});

test("outgoing rows tie-break by callee NAME, matching the live walk", () => {
  const dir = makeRepo({
    "src/z.ts": "export function alpha(){return 1;}\nexport function beta(){return 2;}\nexport function gamma(){return 3;}\n",
    // Declared gamma-first so insertion order can't accidentally satisfy the sort.
    "src/caller.ts":
      'import { alpha, beta, gamma } from "./z";\n' +
      "export function run(){ return gamma() + beta() + alpha(); }\n",
  });
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    const [cached, live] = bothPaths(dir, "--calls", "run", "--in", "src/caller.ts", "--json");
    assert.equal(cached, live);
    assert.deepEqual(JSON.parse(cached).calls.map((c) => c.name), ["alpha", "beta", "gamma"]);
  } finally { cleanup(dir); }
});

test("a sidecar predating these fields is rejected, not half-read", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    const p = join(dir, EDGES);
    const c = JSON.parse(readFileSync(p, "utf8"));
    // Old format: rows without calleeLine/calleeKind/callerDeclLine. Serving these
    // would silently produce rows with `undefined` fields rather than falling back.
    writeFileSync(p, JSON.stringify({ ...c, key: c.key.replace(/e\d+/, "e2") }));
    const [_, live] = [null, run(dir, "--calls", "runA", "--in", "src/callers.ts", "--json").stdout];
    assert.ok(JSON.parse(live).calls.every((x) => x.line !== undefined && x.kind !== undefined),
      "an old-format sidecar must be ignored so the live walk fills these in");
  } finally { cleanup(dir); }
});

test("no sidecar is a normal state — --callers works untouched", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    assert.ok(!existsSync(join(dir, EDGES)), "no sidecar should exist before --build-edges");
    const r = run(dir, "--callers", "target", "--in", "src/target.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).total, 2);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Regressions found by adversarially diffing the two paths against each other.
// Each of these produced FAST != LIVE (or a wrong answer in BOTH) before the fix.
// ---------------------------------------------------------------------------

// `new Foo()` is an invocation. invocationOf() only matched CallExpression, so a
// class reachable ONLY via `new` reported ZERO callers — a silent wrong answer,
// exit 1, indistinguishable from genuinely unused. Independent of the sidecar:
// the live walk had this bug on its own, and so did --depth >= 2.
test("new Foo() is a call site (live walk, no sidecar)", () => {
  const dir = makeRepo({
    "src/widget.ts": "export class Foo { method() { return 1; } }\n",
    "src/consumer.ts":
      'import { Foo } from "./widget";\n' +
      "export function App() { const o = new Foo(); return o; }\n",
  });
  try {
    gitInit(dir, { commit: true });
    assert.ok(!existsSync(join(dir, EDGES)), "this asserts the LIVE path");
    const out = JSON.parse(run(dir, "--callers", "Foo", "--in", "src/widget.ts", "--json").stdout);
    assert.equal(out.total, 1, `new Foo() must count as a caller, got ${JSON.stringify(out.callers)}`);
    assert.equal(out.callers[0].caller, "App");
  } finally { cleanup(dir); }
});

// `export { impl as Widget }` binds the export to `Widget` while the declaration
// node is still named `impl`. Phase A resolves the query by EXPORTED name, so
// keying sidecar edges on the node's own name made the symbol look uncalled.
test("a symbol exported under a different name than its declaration", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", moduleResolution: "bundler", module: "esnext", target: "esnext", baseUrl: "." } }),
    "src/widget.ts": "function impl() { return 1; }\nexport { impl as Widget };\n",
    "src/consumer.ts": 'import { Widget } from "./widget";\nexport function App() { return Widget(); }\n',
  });
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    const [cached, live] = bothPaths(dir, "--callers", "Widget", "--in", "src/widget.ts", "--json");
    assert.equal(cached, live);
    assert.equal(JSON.parse(cached).total, 1, "the aliased export has exactly one caller");
  } finally { cleanup(dir); }
});

// go-to-definition walks THROUGH `const wrapped = helper` and returns both the
// local binding and `helper`. Emitting every target credited `helper` with a call
// site that never names it — which the live reference walk does not report.
test("a reassigned local alias does not fabricate a call to the original", () => {
  const dir = makeRepo({
    "src/lib.ts": "export function helper() { return 1; }\n",
    "src/consumer.ts":
      'import { helper } from "./lib";\n' +
      "const wrapped = helper;\n" +
      "export function App() { return wrapped(); }\n",
  });
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    const [cached, live] = bothPaths(dir, "--callers", "helper", "--in", "src/lib.ts", "--json");
    assert.equal(cached, live);
    assert.equal(JSON.parse(cached).total, 0, "`wrapped()` names wrapped, not helper");
  } finally { cleanup(dir); }
});

// A sidecar written by an older agentmap whose edge ROWS meant something
// different must not be served: a missing edge is indistinguishable from "no
// caller", so the failure would be a confident wrong answer with no symptom.
test("a sidecar from a different edge format is not served", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    const p = join(dir, EDGES);
    const c = JSON.parse(readFileSync(p, "utf8"));
    // Same map, older row format — the key must not match.
    writeFileSync(p, JSON.stringify({ ...c, key: c.key.replace(/e\d+/, "e1"), edges: [] }));
    const out = JSON.parse(run(dir, "--callers", "target", "--in", "src/target.ts", "--json").stdout);
    assert.equal(out.total, 2, "an old-format sidecar must be ignored, not believed");
  } finally { cleanup(dir); }
});

test("LAZY: normal commands neither read nor write the sidecar", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    for (const cmd of [["--relates", "src/target.ts"], ["--find", "target"], ["--hubs"], ["--map"]]) {
      run(dir, ...cmd);
      assert.ok(!existsSync(join(dir, EDGES)), `${cmd[0]} must not build the sidecar`);
    }
  } finally { cleanup(dir); }
});
