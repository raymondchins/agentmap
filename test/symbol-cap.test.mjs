// SPDX-License-Identifier: MIT
// ============================================================================
//  Batch 3 — cap unbounded symbol matches. A broad --find/--any used to emit
//  every matching export (thousands on a big repo, ~93k tokens), defeating the
//  token-savings point. Matches are now ranked by the containing file's PageRank
//  and capped to SYMBOL_MATCH_LIMIT (50) with a "showing top N of M" footer in
//  both prose and JSON.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// 60 leaf files (no importers → low PageRank) each exporting a "sym*" symbol,
// plus one hub exporting a "sym*" symbol imported by 6 files (high PageRank).
// The hub file is written LAST, so insertion order would drop it from a naive
// top-50 slice — PageRank ranking must float it into the shown set.
function bigRepo() {
  const files = {};
  for (let i = 0; i < 60; i++) files[`leaf/mod${i}.ts`] = `export const symLeaf${i} = ${i};\n`;
  for (let i = 0; i < 6; i++) files[`consumer${i}.ts`] = `import { symHub } from './hub';\nexport const c${i} = symHub;\n`;
  files["hub.ts"] = "export const symHub = 1;\n";
  return files;
}

test("--find caps matches at 50 with a footer, keeping the high-PageRank match", () => {
  const dir = makeRepo(bigRepo());
  try {
    gitInit(dir, { commit: true });
    const o = JSON.parse(run(dir, "--find", "sym", "--json").stdout);
    assert.equal(o.total, 61, "61 total matches (60 leaves + hub)");
    assert.equal(o.shown, 50, "capped to 50");
    assert.equal(o.truncated, true);
    assert.equal(o.matches.length, 50);
    assert.ok(o.matches.some((m) => m.name === "symHub"),
      "the high-PageRank symbol must survive the cap (ranked, not insertion-ordered)");
    assert.equal(o.matches[0].name, "symHub", "highest-PageRank match ranks first");
    assert.match(run(dir, "--find", "sym").stdout, /showing top 50 by pagerank/);
  } finally { cleanup(dir); }
});

test("--any caps symbol matches with symbolsTotal / symbolsTruncated", () => {
  const dir = makeRepo(bigRepo());
  try {
    gitInit(dir, { commit: true });
    const o = JSON.parse(run(dir, "--any", "sym", "--json").stdout);
    assert.equal(o.kind, "structure");
    assert.equal(o.symbolsTotal, 61);
    assert.equal(o.symbols.length, 50);
    assert.equal(o.symbolsTruncated, true);
    assert.ok(o.symbols.some((s) => s.name === "symHub"));
    assert.match(run(dir, "--any", "sym").stdout, /showing top 50 of 61 by pagerank/);
  } finally { cleanup(dir); }
});

test("small result sets are not truncated (no footer, truncated=false)", () => {
  const dir = makeRepo({ "a.ts": "export const alpha = 1;\nexport const alphaBeta = 2;\n" });
  try {
    gitInit(dir, { commit: true });
    const o = JSON.parse(run(dir, "--find", "alpha", "--json").stdout);
    assert.equal(o.total, 2);
    assert.equal(o.shown, 2);
    assert.equal(o.truncated, false);
    assert.doesNotMatch(run(dir, "--find", "alpha").stdout, /showing top/);
  } finally { cleanup(dir); }
});
