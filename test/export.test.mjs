// SPDX-License-Identifier: MIT
// ============================================================================
//  Graph export — `--export mermaid|dot`.
//
//  Serializes the FILE import graph (nodes=files, edges=imports, top-N by
//  PageRank) as Graphviz DOT or Mermaid, straight from the cached map (no
//  ts-morph Project — the fast path is untouched). Invariants pinned:
//    • both formats are structurally valid, with no dangling edges past the cap,
//    • Mermaid ids are sanitized (no raw slash/dot paths as bare node ids),
//    • output is deterministic,
//    • --focus scopes to a neighborhood; usage errors exit 2.
//
//  Run: node --test test/export.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// a → b → c import chain.
const chain = () => ({
  "src/a.ts": 'import { b } from "./b";\nexport function a() { return b(); }\n',
  "src/b.ts": 'import { c } from "./c";\nexport function b() { return c(); }\n',
  "src/c.ts": "export function c() { return 1; }\n",
});

test("--export dot is valid Graphviz with no dangling edges", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--export", "dot");
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /^\/\/ agentmap import graph/, "leading comment header");
    assert.match(out, /digraph agentmap \{/);
    assert.match(out, /rankdir=LR;/);
    assert.match(out, /"src\/a\.ts" -> "src\/b\.ts";/, "a→b edge");
    assert.ok(out.trimEnd().endsWith("}"), "closes the digraph");
    // no dangling edges: every endpoint of a `X -> Y` must be a declared node.
    const declared = new Set([...out.matchAll(/^  ("[^"]+") \[label=/gm)].map((m) => m[1]));
    for (const m of out.matchAll(/^  ("[^"]+") -> ("[^"]+");/gm)) {
      assert.ok(declared.has(m[1]) && declared.has(m[2]), `dangling edge ${m[1]}->${m[2]}`);
    }
  } finally { cleanup(dir); }
});

test("--export mermaid is valid + ids are sanitized (no raw paths as node ids)", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--export", "mermaid");
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /flowchart TD/);
    assert.match(out, /classDef hub /);
    assert.match(out, /-->/, "at least one edge");
    // every node-declaration line uses a sanitized nN id, never a raw slash/dot path.
    for (const line of out.split("\n").filter((l) => l.includes(":::"))) {
      assert.match(line, /^ {2}n\d+\["/, `mermaid node id must be sanitized: ${line}`);
    }
  } finally { cleanup(dir); }
});

test("--export output is deterministic", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    assert.equal(run(dir, "--export", "mermaid").stdout, run(dir, "--export", "mermaid").stdout);
  } finally { cleanup(dir); }
});

test("--focus scopes to a neighborhood; unknown focus falls back to the full graph (exit 1)", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    const scoped = run(dir, "--export", "dot", "--focus", "b.ts");
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stdout, /focus src\/b\.ts/, "header notes the focus");
    assert.match(scoped.stdout, /"src\/b\.ts"/);

    const miss = run(dir, "--export", "dot", "--focus", "nope");
    assert.equal(miss.status, 1, "unknown focus is a soft miss (exit 1)");
    assert.match(miss.stdout, /digraph agentmap/, "full graph still emitted");
  } finally { cleanup(dir); }
});

test("usage errors: bad/missing format, --json conflict, and command conflict all exit 2", () => {
  const dir = makeRepo(chain());
  try {
    gitInit(dir, { commit: true });
    assert.equal(run(dir, "--export").status, 2, "missing format");
    assert.equal(run(dir, "--export", "xml").status, 2, "bad format");
    assert.equal(run(dir, "--export", "dot", "--json").status, 2, "--json is a competing output contract");
    assert.equal(run(dir, "--export", "dot", "--map").status, 2, "two commands at once");
  } finally { cleanup(dir); }
});
