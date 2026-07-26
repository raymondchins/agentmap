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
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

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
    const r = run(dir, "--callers", "target", "--in", "src/target.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).total, 2);
    // Truncated-but-valid JSON with the wrong shape must also fall back.
    writeFileSync(join(dir, EDGES), JSON.stringify({ schema: 999, key: "nope", edges: "not-an-array" }));
    assert.equal(JSON.parse(run(dir, "--callers", "target", "--in", "src/target.ts", "--json").stdout).total, 2);
  } finally { cleanup(dir); }
});

test("query shapes the sidecar cannot represent still use the live walk", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--build-edges");
    // --depth >= 2 needs findReferences-able NODES to recurse on; --calls is the
    // opposite direction with a different output shape. Both must keep working.
    const [d2c, d2l] = bothPaths(dir, "--callers", "target", "--in", "src/target.ts", "--depth", "2", "--json");
    assert.equal(d2c, d2l, "--depth 2 must not be served from the sidecar");
    const [cc, cl] = bothPaths(dir, "--calls", "runA", "--in", "src/callers.ts", "--json");
    assert.equal(cc, cl, "--calls must not be served from the sidecar");
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
