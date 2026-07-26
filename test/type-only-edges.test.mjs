// SPDX-License-Identifier: MIT
// ============================================================================
//  Type-only edges — compile-time dependencies, kept out of the runtime graph
//  but no longer thrown away.
//
//  `import type { T } from "./x"` was skipped outright, on the correct reasoning
//  that a type import has no runtime existence and must not inflate PageRank.
//  The cost was invisible and large: the imported file's `dependents` came back
//  EMPTY, so a file every consumer depends on read exactly like an orphan.
//  Measured on vercel/chatbot@c2f8235e1f3ea903ad8b7f61447c4f74164b5c58 —
//  lib/types.ts has 23 importers, all 23 type-only, and --relates reported
//  `dependents (0): —`. 22.4% of that repo's import statements are type-only.
//
//  So these land in their OWN fields. `imports`/`dependents` keep meaning "breaks
//  at runtime"; `typeOnlyImports`/`typeOnlyDependents` mean "breaks at compile
//  time". PageRank, edgeCoverage, symbol ranking and --export all still see the
//  runtime graph exactly as before — asserted below, not assumed.
//
//  Run: node --test test/type-only-edges.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const REPO = {
  "src/types.ts": "export type T = { a: number };\nexport type U = { b: string };\nexport function realFn() { return 1; }\n",
  "src/onlyType.ts": 'import type { T } from "./types";\nexport function useT(x: T) { return x.a; }\n',
  "src/exportType.ts": 'export type { U } from "./types";\n',
  "src/mixed.ts": 'import { realFn, type T } from "./types";\nexport function useBoth(x: T) { return realFn() + x.a; }\n',
};

const relates = (dir, f) => JSON.parse(run(dir, "--relates", f, "--json").stdout);

test("a whole-statement type import is recorded, apart from the runtime imports", () => {
  const dir = makeRepo(REPO);
  gitInit(dir, { commit: true });
  try {
    const j = relates(dir, "src/onlyType.ts");
    assert.deepEqual(j.imports, [], "a type import must not become a runtime edge");
    assert.deepEqual(j.typeOnlyImports, ["src/types.ts"]);
  } finally { cleanup(dir); }
});

test("the imported file now lists its compile-time dependents instead of looking orphaned", () => {
  const dir = makeRepo(REPO);
  gitInit(dir, { commit: true });
  try {
    const j = relates(dir, "src/types.ts");
    assert.deepEqual(j.dependents, ["src/mixed.ts"], "only the runtime importer belongs in dependents");
    assert.deepEqual(j.typeOnlyDependents, ["src/exportType.ts", "src/onlyType.ts"]);
  } finally { cleanup(dir); }
});

test("`export type { T } from` is captured too", () => {
  const dir = makeRepo(REPO);
  gitInit(dir, { commit: true });
  try {
    assert.deepEqual(relates(dir, "src/exportType.ts").typeOnlyImports, ["src/types.ts"]);
  } finally { cleanup(dir); }
});

test("a mixed statement stays a runtime edge and is not double-listed", () => {
  // `import { realFn, type T }` crosses at runtime, so the runtime edge is the
  // stronger and only claim — the same target in both arrays would double-count it.
  const dir = makeRepo(REPO);
  gitInit(dir, { commit: true });
  try {
    const j = relates(dir, "src/mixed.ts");
    assert.deepEqual(j.imports, ["src/types.ts"]);
    assert.ok(!("typeOnlyImports" in j), `target double-listed: ${JSON.stringify(j.typeOnlyImports)}`);
  } finally { cleanup(dir); }
});

test("an import whose specifiers are ALL inline-type is erased, not a runtime edge", () => {
  // `import { type A, type B }` emits nothing at all. Filtering the type
  // specifiers leaves an empty name list, which the edge builder could not tell
  // apart from a side-effect `import "./x"` — so it fell through to the ["*"]
  // fallback and fabricated a runtime dependency. This is the shape
  // @typescript-eslint's consistent-type-imports writes under
  // fixStyle:"inline-type-imports", so it is common in the wild.
  const dir = makeRepo({
    "src/a.ts": "export type A = { a: number };\nexport type B = { b: number };\n",
    "src/b.ts": 'import { type A, type B } from "./a";\nexport function f(x: A, y: B) { return 1; }\n',
  });
  gitInit(dir, { commit: true });
  try {
    const j = relates(dir, "src/b.ts");
    assert.deepEqual(j.imports, []);
    assert.deepEqual(j.typeOnlyImports, ["src/a.ts"]);
  } finally { cleanup(dir); }
});

test("a side-effect import keeps its runtime edge", () => {
  // The guard on the fix above: `import "./x"` has zero specifiers and DOES run.
  // Only a non-zero specifier count that is entirely type-only means erasure.
  const dir = makeRepo({
    "src/a.ts": "console.log('side effect');\nexport const a = 1;\n",
    "src/b.ts": 'import "./a";\nexport const b = 2;\n',
  });
  gitInit(dir, { commit: true });
  try {
    const j = relates(dir, "src/b.ts");
    assert.deepEqual(j.imports, ["src/a.ts"]);
    assert.ok(!("typeOnlyImports" in j), "a side-effect import was wrongly erased");
  } finally { cleanup(dir); }
});

test("`export { type X } from` is erased but `export * from` stays a runtime edge", () => {
  // Both have zero *value* named exports after filtering; only the specifier count
  // separates them, and a star re-export is a real runtime dependency.
  const dir = makeRepo({
    "src/z.ts": "export type X = { x: number };\nexport function run() { return 1; }\n",
    "src/typed.ts": 'export { type X } from "./z";\n',
    "src/star.ts": 'export * from "./z";\n',
  });
  gitInit(dir, { commit: true });
  try {
    const t = relates(dir, "src/typed.ts");
    assert.deepEqual(t.imports, [], "a type-only named re-export fabricated a runtime edge");
    assert.deepEqual(t.typeOnlyImports, ["src/z.ts"]);

    const s = relates(dir, "src/star.ts");
    assert.deepEqual(s.imports, ["src/z.ts"], "a star re-export must stay a runtime edge");
  } finally { cleanup(dir); }
});

test("the runtime graph is untouched — PageRank ignores the type-only edges", () => {
  // The guard on the whole design. The control keeps the SAME four files and the
  // same runtime edges, and only drops the type imports (declaring the types
  // locally instead) — deleting the files outright would change the node count
  // and move PageRank for reasons that have nothing to do with this feature.
  const withTypes = makeRepo(REPO);
  const withoutTypes = makeRepo({
    ...REPO,
    "src/onlyType.ts": "type T = { a: number };\nexport function useT(x: T) { return x.a; }\n",
    "src/exportType.ts": "export type U = { b: string };\n",
  });
  gitInit(withTypes, { commit: true });
  gitInit(withoutTypes, { commit: true });
  try {
    const a = relates(withTypes, "src/types.ts").pagerank;
    const b = relates(withoutTypes, "src/types.ts").pagerank;
    assert.equal(a, b, `type-only edges moved PageRank: ${a} vs ${b}`);
  } finally { cleanup(withTypes); cleanup(withoutTypes); }
});

test("type-only imports do not count against edge coverage health", () => {
  // edgeCoverage answers "did runtime imports resolve" — a type import that
  // resolves or fails must not move that signal either way.
  const dir = makeRepo(REPO);
  gitInit(dir, { commit: true });
  try {
    run(dir, "--map");
    const m = JSON.parse(readFileSync(join(dir, ".claude/agentmap/map.json"), "utf8"));
    assert.equal(m.degraded, false);
    assert.equal(m.edgeCoverage, 1, `edgeCoverage moved: ${m.edgeCoverage}`);
  } finally { cleanup(dir); }
});

test("prose lists compile-time relationships separately from runtime ones", () => {
  const dir = makeRepo(REPO);
  gitInit(dir, { commit: true });
  try {
    const out = run(dir, "--relates", "src/types.ts").stdout;
    assert.match(out, /dependents \(1\): src\/mixed\.ts/);
    assert.match(out, /type-only dependents \(2\): src\/exportType\.ts, src\/onlyType\.ts/);
  } finally { cleanup(dir); }
});

test("a repo with no type imports serialises exactly as before", () => {
  const dir = makeRepo({
    "src/a.ts": "export function A() { return 1; }\n",
    "src/b.ts": 'import { A } from "./a";\nexport function B() { return A(); }\n',
  });
  gitInit(dir, { commit: true });
  try {
    run(dir, "--map");
    const raw = readFileSync(join(dir, ".claude/agentmap/map.json"), "utf8");
    assert.ok(!/typeOnly/.test(raw), "the new fields leaked into a repo that has no type-only imports");
  } finally { cleanup(dir); }
});
