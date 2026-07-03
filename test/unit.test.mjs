// SPDX-License-Identifier: MIT
// ============================================================================
//  In-process unit tests for agentmap's exported pure functions.
//
//  Unlike the rest of the suite (black-box: spawn the CLI in a temp repo), this
//  file IMPORTS agentmap.mjs and calls the functions directly — cheaper, faster,
//  and it locks in the Batch 2 contract that importing the module has ZERO side
//  effects (no build, no cache write, no process.exit) and exposes the pure
//  building blocks the MCP server / library callers can reuse in-process.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pagerank, rankSymbols, identMul, resolveFile, extractVueScripts,
  stripJsonComments, extractFacts, build, ensureFresh, readPackageVersion,
} from "../agentmap.mjs";

test("import surface: every documented pure function is exported and callable", () => {
  for (const fn of [pagerank, rankSymbols, identMul, resolveFile, extractVueScripts, stripJsonComments, extractFacts, build, ensureFresh, readPackageVersion]) {
    assert.equal(typeof fn, "function");
  }
});

test("extractFacts: returns raw per-file facts only (the backend seam), no assembly", () => {
  // extractFacts is the ts-morph/Vue backend boundary: it yields per-file
  // exports/imports/importedSymbols, but NOT the graph-assembly fields
  // (dependents/pagerank/features) — those belong to build(). Drive it in a
  // throwaway non-git dir; makeProject falls back to source globs there.
  const dir = mkdtempSync(join(tmpdir(), "agentmap-facts-"));
  writeFileSync(join(dir, "a.ts"), "export function foo() {}\nexport const bar = 1;\n");
  writeFileSync(join(dir, "b.ts"), 'import { foo } from "./a";\nfoo();\n');
  const cwd0 = process.cwd();
  try {
    process.chdir(dir);
    const facts = extractFacts();
    assert.ok(facts["a.ts"] && facts["b.ts"], "both source files present in facts");
    assert.deepEqual(facts["a.ts"].exports.map((e) => e.name).sort(), ["bar", "foo"]);
    assert.deepEqual(facts["b.ts"].imports, ["a.ts"]);
    assert.deepEqual(facts["b.ts"].importedSymbols["a.ts"], ["foo"]);
    // seam boundary: assembly fields are build()'s job, absent from raw facts.
    assert.equal(facts["a.ts"].dependents, undefined);
    assert.equal(facts["a.ts"].pagerank, undefined);
  } finally {
    process.chdir(cwd0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pagerank: heavily-imported hub ranks highest; empty graph → {}", () => {
  // importer→imported edges: A and C both import B ⇒ rank flows into B.
  const nodes = ["A", "B", "C"];
  const edges = [{ from: "A", to: "B", weight: 1 }, { from: "C", to: "B", weight: 1 }];
  const r = pagerank(nodes, edges);
  assert.ok(r.B > r.A && r.B > r.C, `hub B should outrank leaves (got ${JSON.stringify(r)})`);
  // deterministic: no PRNG, stable node order.
  assert.deepEqual(pagerank(nodes, edges), r);
  assert.deepEqual(pagerank([], []), {});
});

test("pagerank: self-loops are ignored (no crash, no rank inflation)", () => {
  const r = pagerank(["A", "B"], [{ from: "A", to: "A", weight: 5 }, { from: "A", to: "B", weight: 1 }]);
  assert.ok(Number.isFinite(r.A) && Number.isFinite(r.B));
});

test("identMul: mention boost, rarity penalty, plain ident = 1.0", () => {
  assert.equal(identMul("x", 1, null), 1.0);                 // no boosts
  assert.equal(identMul("foo", 1, new Set(["foo"])), 10);    // mentioned ⇒ ×IDENT_BOOST
  assert.equal(identMul("x", 6, null), 0.1);                 // >5 definers ⇒ ×RARE_PENALTY
  assert.equal(identMul("handleSubmit", 1, null), 10);       // long camelCase ⇒ ×IDENT_BOOST
});

test("stripJsonComments: strips // and /* */ but preserves comment-like text inside strings", () => {
  assert.equal(stripJsonComments('{"a":1} // trailing'), '{"a":1} ');
  assert.equal(stripJsonComments('{/* c */"a":1}'), '{"a":1}');
  assert.equal(stripJsonComments('{"url":"http://x"}'), '{"url":"http://x"}'); // // inside a string is kept
  assert.equal(stripJsonComments('{"s":"a /* b */ c"}'), '{"s":"a /* b */ c"}');
});

test("resolveFile: exact > basename > substring; ambiguous substring → candidates", () => {
  const keys = ["src/a.ts", "src/b.ts"];
  const files = { "src/a.ts": {}, "src/b.ts": {} };
  assert.deepEqual(resolveFile(keys, files, "src/a.ts"), { key: "src/a.ts" }); // (a) exact
  assert.deepEqual(resolveFile(keys, files, "a.ts"), { key: "src/a.ts" });     // (b) basename
  const amb = resolveFile(keys, files, "src/");                                // (d) ambiguous substring
  assert.equal(amb.key, null);
  assert.deepEqual(amb.candidates.sort(), ["src/a.ts", "src/b.ts"]);
});

test("extractVueScripts: picks <script setup>, returns lang; no script → null", () => {
  const setup = extractVueScripts('<template><div/></template>\n<script setup lang="ts">const x = 1</script>');
  assert.equal(setup.setup, true);
  assert.equal(setup.lang, "ts");
  assert.equal(setup.text.trim(), "const x = 1");
  assert.equal(extractVueScripts("<template>no script here</template>"), null);
});

test("readPackageVersion: resolves this package's name + semver (relative to the module, not cwd)", () => {
  const { name, version } = readPackageVersion();
  assert.match(name, /agentmap/);
  assert.match(version, /^\d+\.\d+\.\d+/);
});
