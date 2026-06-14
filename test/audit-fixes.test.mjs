// SPDX-License-Identifier: MIT
// Regression tests for the 2026-06-14 audit fixes (security/correctness/robustness
// sweep). Each test locks in one finding so it can't silently regress.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// --- #1 (medium): one pathological file must NOT abort the whole map --------
// Before the fix, the per-file parse loop had no try/catch, so a single file
// that made ts-morph throw aborted build() entirely (exit 1, no output) —
// the opposite of the advertised graceful-degradation contract.
test("poison-pill file: one unparseable source is skipped, build still succeeds", () => {
  const dir = makeRepo({
    // template-literal (non-string-literal) import specifier — the kind of
    // malformed source that makes ts-morph throw inside the parse loop.
    "broken.ts": "import foo from `./nope`;\nexport const broken = foo;\n",
    "good.ts": `export function survivorSymbolXYZ() { return 42; }`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--find", "survivorSymbolXYZ");
  assert.equal(r.status, 0, `build crashed on a poison-pill file (status ${r.status}): ${r.stderr}`);
  assert.match(r.stdout, /survivorSymbolXYZ/, "valid sibling file was not indexed after skipping the bad one");
  cleanup(dir);
});

// --- #3 (low): tsconfig path aliases resolve for dynamic import()/require() --
// Before the fix, resolveSpec returned null for any non-relative specifier, so
// `import("@/x")` / `require("@/x")` / `import "@/x"` formed no edge.
test("tsconfig path alias resolves for a dynamic import() edge", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { allowJs: true, baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }),
    "src/target.ts": `export function aliasTargetSymbol() { return 1; }`,
    "src/consumer.ts": `export async function load() { return import("@/target"); }`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "src/target.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /consumer/, "alias dynamic import() did not form a dependency edge");
  cleanup(dir);
});

// --- #6 (low): a tiny --tokens budget must still emit the top file ----------
// Before the fix, the partial-recovery loop never tested the single-symbol
// block, so a tiny budget could emit an empty digest for the top file.
test("--map with a tiny budget still shows the top file (never wholly omitted)", () => {
  const dir = makeRepo({
    "a.ts": `export function alpha() {}\nexport function beta() {}\nexport function gamma() {}`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--map", "--tokens", "30");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /a\.ts/, "tiny budget produced an empty digest (top file wholly omitted)");
  cleanup(dir);
});
