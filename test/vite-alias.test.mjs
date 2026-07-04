// SPDX-License-Identifier: MIT
// ============================================================================
//  FIX #5 — vite.config / webpack resolve.alias read into the alias resolver.
//  A repo that aliases '@/' ONLY in vite.config (the default `npm create vite`
//  shape — bare tsconfig, no `paths`) must still resolve `@/…` import edges.
//  Guards: a no-vite repo stays unaffected; tsconfig wins on a same-key
//  conflict; and the config is NEVER executed (a throwing config still yields
//  the edge — proves AST-only extraction, no eval/import/require).
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const VITE_AT_SRC = [
  "import { defineConfig } from 'vite';",
  "import path from 'path';",
  "export default defineConfig({ resolve: { alias: { '@': path.resolve(__dirname, './src') } } });",
  "",
].join("\n");

test("vite-only '@' alias resolves an import edge (tsconfig has no paths)", () => {
  const dir = makeRepo({
    "vite.config.ts": VITE_AT_SRC,
    "tsconfig.json": '{ "compilerOptions": { "allowJs": true } }',
    "src/foo.ts": "export function fooSym(){ return 42; }\n",
    "src/main.ts": "import { fooSym } from '@/foo';\nexport const use = fooSym();\n",
  });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--relates", "src/main.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).imports, ["src/foo.ts"],
      "the '@/foo' import aliased only in vite.config must resolve to src/foo.ts");
    const rev = JSON.parse(run(dir, "--relates", "src/foo.ts", "--json").stdout);
    assert.ok(rev.dependents.includes("src/main.ts"), "src/foo.ts must list src/main.ts as a dependent");
  } finally { cleanup(dir); }
});

test("vite '@' alias also matches the bare specifier (exact, not just wildcard)", () => {
  const dir = makeRepo({
    "vite.config.ts": VITE_AT_SRC,
    "tsconfig.json": '{ "compilerOptions": { "allowJs": true } }',
    "src/index.ts": "export function barrelSym(){ return 1; }\n",
    "src/main.ts": "import { barrelSym } from '@';\nexport const use = barrelSym();\n",
  });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--relates", "src/main.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).imports, ["src/index.ts"],
      "bare '@' must resolve to src/index.ts via the exact-alias + /index resolution");
  } finally { cleanup(dir); }
});

test("no vite.config repo is unaffected (relative edges still resolve, nothing added)", () => {
  const dir = makeRepo({
    "tsconfig.json": '{"compilerOptions":{"allowJs":true}}',
    "src/a.ts": "export function fromA(){ return 1; }\n",
    "src/b.ts": "import { fromA } from './a';\nexport const u = fromA();\n",
  });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--relates", "src/b.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).imports, ["src/a.ts"],
      "a repo with no vite.config must behave exactly as before");
  } finally { cleanup(dir); }
});

test("tsconfig paths WIN over a conflicting vite alias on the same key", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true, baseUrl: ".", paths: { "@/*": ["src/real/*"] } } }),
    "vite.config.ts": [
      "import { defineConfig } from 'vite';",
      "import path from 'path';",
      "export default defineConfig({ resolve: { alias: { '@': path.resolve(__dirname, 'src/vitewrong') } } });",
      "",
    ].join("\n"),
    "src/real/foo.ts": "export function tsWins(){ return 't'; }\n",
    "src/vitewrong/foo.ts": "export function viteLoses(){ return 'v'; }\n",
    "src/main.ts": "import { tsWins } from '@/foo';\nexport const u = tsWins();\n",
  });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--relates", "src/main.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).imports, ["src/real/foo.ts"],
      "the tsconfig '@/*' target must win over the vite '@' alias on the same key");
  } finally { cleanup(dir); }
});

test("SECURITY: the vite config is NEVER executed (a throwing config still yields the edge)", () => {
  const dir = makeRepo({
    "vite.config.ts": "throw new Error('vite config executed — SECURITY FAIL');\n" + VITE_AT_SRC,
    "tsconfig.json": '{ "compilerOptions": { "allowJs": true } }',
    "src/foo.ts": "export function fooSym(){ return 1; }\n",
    "src/main.ts": "import { fooSym } from '@/foo';\nexport const use = fooSym();\n",
  });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--relates", "src/main.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).imports, ["src/foo.ts"],
      "a throwing vite.config must still resolve the alias — proves AST-only, no execution");
  } finally { cleanup(dir); }
});
