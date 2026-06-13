// SPDX-License-Identifier: MIT
// Contract #3 — dirtyCount untracked-DIR staleness fix.
// Bug: `git status --porcelain` (default untracked-files=normal) folds a new
// file inside a BRAND-NEW untracked directory into "?? newdir/", so the
// .ts/.tsx extension regex misses it → dirtyCount()===0 → a STALE cache is
// served and the fresh symbol is invisible. Post-fix uses
// --untracked-files=all so each new file is listed individually and the cache
// rebuilds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, writeFiles, run, cleanup } from "./helpers.mjs";

test("--find sees a symbol added in a NEW untracked directory (cache rebuilds)", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
    "src/index.ts": `export function existing() { return 1; }`,
  });
  // Commit a clean baseline so the cache it builds is trusted (dirty===0).
  gitInit(dir, { commit: true });

  // Prime the cache on the clean tree.
  const prime = run(dir, "--find", "existing");
  assert.equal(prime.status, 0);
  assert.match(prime.stdout, /existing/);

  // Now add a fresh symbol in a NEW, never-before-seen directory — the exact
  // shape the old porcelain-folding bug missed.
  writeFiles(dir, { "freshpkg/newmod.ts": `export function brandNewSymbol() { return 99; }` });

  const r = run(dir, "--find", "brandNewSymbol");
  assert.equal(r.status, 0, `--find after new-dir add failed: ${r.stderr}`);
  assert.match(r.stdout, /brandNewSymbol/, "stale cache served — new-dir file not reindexed");
  // And it must report at least one match, not "0 match".
  assert.doesNotMatch(r.stdout, /\b0 match\b/, "reported 0 matches for a symbol that exists");
  cleanup(dir);
});

test("--any reflects a new-untracked-dir file in structure results", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
    "src/index.ts": `export function existing() { return 1; }`,
  });
  gitInit(dir, { commit: true });
  run(dir, "--hubs"); // prime cache clean

  writeFiles(dir, { "deep/nested/dir/widget.ts": `export function uniqueWidgetXYZ() { return 0; }` });
  const r = run(dir, "--any", "uniqueWidgetXYZ");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /uniqueWidgetXYZ/, "new nested-dir symbol not picked up after rebuild");
  cleanup(dir);
});
