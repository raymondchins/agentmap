// SPDX-License-Identifier: MIT
// ============================================================================
//  Transitive call graph — `--depth N` for --callers / --calls.
//
//  N-hop closure over the compiler-accurate call graph, reusing the single warm
//  Project. Invariants pinned here:
//    • --depth reaches transitively (chain top→mid→leaf), each node tagged `depth`,
//    • cycles (a↔b) TERMINATE (no infinite loop) and stay bounded,
//    • --depth is clamped to [1,5]; --depth 1 / 0 / omitted is byte-identical to the
//      single-hop query (no `depth`/`via` fields — the shipped v0.13.0 contract),
//    • deeper nodes carry a `via` parent for chain reconstruction.
//
//  Run: node --test test/depth.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const json = (dir, ...args) => JSON.parse(run(dir, ...args, "--json").stdout);

// top() → mid() → leaf()  (each in one file, all exported)
const chain = () => ({
  "src/chain.ts":
    "export function leaf() { return 1; }\n" +
    "export function mid() { return leaf(); }\n" +
    "export function top() { return mid(); }\n",
});

test("--calls --depth reaches transitively (outgoing), tagging depth + via", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    const d1 = json(dir, "--calls", "top");
    assert.deepEqual(d1.calls.map((c) => c.name).sort(), ["mid"], "depth 1 = direct callee only");

    const d2 = json(dir, "--calls", "top", "--depth", "2");
    assert.equal(d2.depth, 2);
    assert.deepEqual([...new Set(d2.calls.map((c) => c.name))].sort(), ["leaf", "mid"], "depth 2 reaches leaf");
    const mid = d2.calls.find((c) => c.name === "mid");
    const leaf = d2.calls.find((c) => c.name === "leaf");
    assert.equal(mid.depth, 1);
    assert.equal(mid.via, null, "hop-1 node has null via");
    assert.equal(leaf.depth, 2);
    assert.ok(leaf.via, "hop-2 node carries a via parent key");
  } finally { cleanup(dir); }
});

test("--callers --depth reaches transitively (incoming)", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    const d1 = json(dir, "--callers", "leaf");
    assert.deepEqual([...new Set(d1.callers.map((c) => c.caller))].sort(), ["mid"], "depth 1 = direct caller");

    const d2 = json(dir, "--callers", "leaf", "--depth", "2");
    assert.equal(d2.depth, 2);
    assert.deepEqual([...new Set(d2.callers.map((c) => c.caller))].sort(), ["mid", "top"], "depth 2 reaches top");
    assert.equal(d2.callers.find((c) => c.caller === "top").depth, 2);
  } finally { cleanup(dir); }
});

test("--depth beyond the chain stops naturally (no phantom hops)", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    const o = json(dir, "--calls", "top", "--depth", "5");
    assert.deepEqual([...new Set(o.calls.map((c) => c.name))].sort(), ["leaf", "mid"], "traversal halts when the frontier drains");
  } finally { cleanup(dir); }
});

test("a cycle (a↔b) TERMINATES and stays bounded, both directions", () => {
  const dir = makeRepo({
    "src/cyc.ts":
      "export function a() { return b(); }\n" +
      "export function b() { return a(); }\n",
  });
  try {
    gitInit(dir, { commit: true });
    // If cycle detection were broken these would hang; reaching the assert IS the proof.
    const callers = json(dir, "--callers", "a", "--depth", "5");
    assert.ok(callers.callers.some((c) => c.caller === "b"), "b calls a");
    assert.ok(callers.callers.length <= 4, `bounded (got ${JSON.stringify(callers.callers)})`);

    const calls = json(dir, "--calls", "a", "--depth", "5");
    assert.ok(calls.calls.some((c) => c.name === "b"), "a calls b");
    assert.ok(calls.calls.length <= 4, `bounded (got ${JSON.stringify(calls.calls)})`);
  } finally { cleanup(dir); }
});

test("--depth is clamped to [1,5]", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    // huge → clamp to 5 (envelope echoes the clamped depth)
    assert.equal(json(dir, "--calls", "top", "--depth", "99").depth, 5, "--depth 99 clamps to 5");
    // 0 / negative / non-numeric → clamp to 1 → single-hop path (no depth key)
    for (const bad of ["0", "-3", "abc"]) {
      const o = json(dir, "--calls", "top", "--depth", bad);
      assert.ok(!("depth" in o), `--depth ${bad} → single-hop (o=${JSON.stringify(o)})`);
      assert.deepEqual(o.calls.map((c) => c.name).sort(), ["mid"], `--depth ${bad} behaves like depth 1`);
    }
  } finally { cleanup(dir); }
});

test("BACK-COMPAT: depth 1 / omitted is byte-identical to the single-hop contract (no depth/via)", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    for (const args of [["--callers", "mid"], ["--callers", "mid", "--depth", "1"], ["--calls", "mid"], ["--calls", "mid", "--depth", "1"]]) {
      const o = json(dir, ...args);
      assert.ok(!("depth" in o), `${args.join(" ")}: envelope must not carry depth (o=${JSON.stringify(o)})`);
      const rows = o.callers || o.calls;
      for (const r of rows) {
        assert.ok(!("depth" in r), `${args.join(" ")}: rows must not carry depth`);
        assert.ok(!("via" in r), `${args.join(" ")}: rows must not carry via`);
      }
    }
  } finally { cleanup(dir); }
});
