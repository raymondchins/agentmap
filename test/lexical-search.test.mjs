// SPDX-License-Identifier: MIT
// ============================================================================
//  Hybrid lexical retrieval — BM25 `--search` + the `--any` lexical rung.
//
//  Answers VAGUE natural-language queries an agent actually types ("where's the
//  auth retry logic") where exact-substring --find/--any miss and fall through to
//  a whole-phrase git-grep that returns nothing. BM25 over split-identifier tokens
//  (name + path + feature + kind), fused with file PageRank. Invariants pinned:
//    • vague multi-word queries resolve to the right symbol,
//    • the `--any` lexical rung fires ONLY on exact-miss (exact precedence intact),
//    • PageRank fusion breaks ties toward the important file,
//    • stopword-only queries are a clean exit-1 no-match,
//    • output is deterministic.
//
//  Run: node --test test/lexical-search.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// Symbols whose EXACT names don't contain the query phrases — only BM25 over the
// split tokens (name + path) can surface them.
function repo() {
  return {
    "src/authRetry.ts": "export function retryWithBackoff() { return 1; }\n",
    "src/dedup.ts": "export function dedupeSymbols() { return 1; }\n",
    "src/http.ts": "export function fetchJson() { return 1; }\n",
  };
}
const search = (dir, q) => JSON.parse(run(dir, "--search", q, "--json").stdout);

test("--search resolves a vague query to the right symbol via name + path tokens", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const o = search(dir, "auth retry logic");
    assert.equal(o.command, "search");
    assert.ok(o.matches.length, `expected matches (o=${JSON.stringify(o)})`);
    assert.equal(o.matches[0].name, "retryWithBackoff", `top hit (matches=${JSON.stringify(o.matches)})`);
    assert.equal(o.matches[0].file, "src/authRetry.ts");
    assert.equal(typeof o.matches[0].score, "number");
  } finally { cleanup(dir); }
});

test("--search drops stopwords: 'the function that dedupes symbols' ranks dedupeSymbols first", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const o = search(dir, "the function that dedupes symbols");
    assert.equal(o.matches[0].name, "dedupeSymbols", `matches=${JSON.stringify(o.matches)}`);
  } finally { cleanup(dir); }
});

test("--any lexical rung fires ONLY on exact-miss (exact matching keeps precedence)", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    // vague, no exact file/symbol → lexical rung
    assert.equal(JSON.parse(run(dir, "--any", "dedupe symbols", "--json").stdout).kind, "lexical");
    // exact symbol name → structure (NOT lexical)
    assert.equal(JSON.parse(run(dir, "--any", "dedupeSymbols", "--json").stdout).kind, "structure");
    // exact file → file (NOT lexical)
    assert.equal(JSON.parse(run(dir, "--any", "src/http.ts", "--json").stdout).kind, "file");
  } finally { cleanup(dir); }
});

test("PageRank fusion breaks ties toward the important (hub) file", () => {
  const dir = makeRepo({
    "src/parseHub.ts": "export function parse() { return 1; }\n",
    "src/parseLeaf.ts": "export function parse() { return 2; }\n",
    "src/u1.ts": 'import { parse } from "./parseHub";\nexport function u1() { return parse(); }\n',
    "src/u2.ts": 'import { parse } from "./parseHub";\nexport function u2() { return parse(); }\n',
    "src/u3.ts": 'import { parse } from "./parseHub";\nexport function u3() { return parse(); }\n',
  });
  try {
    gitInit(dir, { commit: true });
    const o = search(dir, "parse");
    const first = o.matches.find((m) => m.name === "parse");
    assert.equal(first.file, "src/parseHub.ts", `the imported-widely hub's parse must rank first (matches=${JSON.stringify(o.matches)})`);
  } finally { cleanup(dir); }
});

test("stopword-only / empty query is a clean exit-1 no-match", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--search", "the of for", "--json");
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).total, 0);
  } finally { cleanup(dir); }
});

test("--search JSON shape + determinism", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const a = run(dir, "--search", "fetch json", "--json").stdout;
    const b = run(dir, "--search", "fetch json", "--json").stdout;
    assert.equal(a, b, "two identical searches must be byte-identical");
    const o = JSON.parse(a);
    for (const k of ["command", "query", "total", "shown", "truncated", "matches"]) assert.ok(k in o, `missing ${k}`);
    for (const m of o.matches) for (const k of ["file", "name", "kind", "score"]) assert.ok(k in m, `match missing ${k}`);
  } finally { cleanup(dir); }
});

test("--search with no query is a usage error (exit 2)", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    assert.equal(run(dir, "--search").status, 2);
  } finally { cleanup(dir); }
});
