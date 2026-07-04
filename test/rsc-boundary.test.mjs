// SPDX-License-Identifier: MIT
// ============================================================================
//  React Server/Client boundary tagging — per-file `rsc: 'client' | 'server'`.
//
//  Reads the directive PROLOGUE (compiler-accurate, via the ts-morph statement
//  API — not a text grep), tags each file, and surfaces it in --relates (prose +
//  JSON, CLI + MCP). Additive + discovery-only: it never touches PageRank / edges
//  / features, and the key is ABSENT (not null) for files with no directive, so
//  map.json is byte-identical for non-Next repos.
//
//  Run: node --test test/rsc-boundary.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// One anchor file per directive so --relates has a resolvable, in-graph target.
function repo() {
  return {
    "src/client.tsx": '"use client";\nexport function Island() { return null; }\n',
    "src/server.ts": '"use server";\nexport async function action() { return 1; }\n',
    "src/plain.ts": "export function plain() { return 1; }\n",
    // prologue robustness: a leading comment, a `'use strict'` preamble, and a
    // single-quoted directive must all still resolve to 'client'.
    "src/tricky.tsx": "// leading comment\n'use strict';\n'use client';\nexport function Tricky() { return null; }\n",
  };
}
const rel = (dir, path) => JSON.parse(run(dir, "--relates", path, "--json").stdout);

test("--relates tags a 'use client' file (JSON + prose)", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const o = rel(dir, "src/client.tsx");
    assert.equal(o.rsc, "client", `client boundary in JSON (o=${JSON.stringify(o)})`);
    const prose = run(dir, "--relates", "src/client.tsx").stdout;
    assert.match(prose, /boundary: 'use client'/, "prose shows the boundary line");
  } finally { cleanup(dir); }
});

test("--relates tags a 'use server' file", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    assert.equal(rel(dir, "src/server.ts").rsc, "server");
  } finally { cleanup(dir); }
});

test("a file with no directive has NO rsc key (byte-identical shape)", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const o = rel(dir, "src/plain.ts");
    assert.ok(!("rsc" in o), `plain file must not carry rsc (o=${JSON.stringify(o)})`);
  } finally { cleanup(dir); }
});

test("prologue robustness: leading comment + 'use strict' preamble + single quotes still detect 'client'", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    assert.equal(rel(dir, "src/tricky.tsx").rsc, "client");
  } finally { cleanup(dir); }
});

test("BYTE-IDENTICAL guard: a repo with zero directives has no `rsc` anywhere in map.json", () => {
  const dir = makeRepo({
    "src/a.ts": "export function a() { return 1; }\n",
    "src/b.ts": 'import { a } from "./a";\nexport function b() { return a(); }\n',
  });
  try {
    gitInit(dir, { commit: true });
    run(dir, "--symbols", "--json"); // force a build
    const raw = readFileSync(join(dir, ".claude/agentmap/map.json"), "utf8");
    assert.ok(!raw.includes('"rsc"'), "no rsc key must appear in a directive-free map");
  } finally { cleanup(dir); }
});
