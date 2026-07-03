// SPDX-License-Identifier: MIT
// ============================================================================
//  Batch 5 correctness quick-wins:
//   - resolveFile prototype-pollution (Object.prototype-name queries)
//   - longest-prefix tsconfig `paths` alias precedence
//   - tsconfig `extends` baseUrl/paths origin anchoring
//   - non-ASCII / special-char filenames surviving git ls-files
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

test("resolveFile: Object.prototype-name queries never fabricate a file hit or crash", () => {
  const dir = makeRepo({ "src/a.ts": "export function helperA(){ return 1; }\n" });
  try {
    gitInit(dir, { commit: true });
    for (const q of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      const anyR = run(dir, "--any", q, "--json");
      assert.doesNotMatch(anyR.stderr, /TypeError|Cannot read/, `--any ${q} must not crash`);
      const j = JSON.parse(anyR.stdout);
      assert.notEqual(j.kind, "file", `--any ${q} must not fabricate kind:"file"`);
      const relR = run(dir, "--relates", q, "--json");
      assert.doesNotMatch(relR.stderr, /TypeError|Cannot read/, `--relates ${q} must not crash`);
      assert.notEqual(JSON.parse(relR.stdout).file, q, `--relates ${q} must not fabricate a file`);
    }
  } finally { cleanup(dir); }
});

test("longest-prefix alias wins over an overlapping shorter alias", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: {
      "@/*": ["src/*"], "@/components/*": ["src/ui/*"],
    } } }),
    "src/ui/Button.ts": "export function specificButton(){ return 1; }\n",
    "src/components/Button.ts": "export function wrongButton(){ return 2; }\n",
    // dynamic import always routes through resolveAlias (no ts-morph native shortcut)
    "src/App.ts": "export async function App(){ return import('@/components/Button'); }\n",
  });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--relates", "src/App.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).imports, ["src/ui/Button.ts"],
      "must resolve to the MORE SPECIFIC @/components/* alias, not @/*");
  } finally { cleanup(dir); }
});

test("non-overlapping aliases keep resolving (no regression from the specificity sort)", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "~/*": ["lib/*"] } } }),
    "src/a.ts": "export function fromSrc(){ return 1; }\n",
    "lib/b.ts": "export function fromLib(){ return 2; }\n",
    "consumer.ts": "import { fromSrc } from '@/a';\nexport const u = import('~/b');\nexport const v = fromSrc();\n",
  });
  try {
    gitInit(dir, { commit: true });
    const imports = JSON.parse(run(dir, "--relates", "consumer.ts", "--json").stdout).imports;
    assert.ok(imports.includes("src/a.ts"), "@/ alias still resolves");
    assert.ok(imports.includes("lib/b.ts"), "~/ alias still resolves");
  } finally { cleanup(dir); }
});

test("tsconfig extends: inherited baseUrl/paths anchor to the BASE config's dir", () => {
  const dir = makeRepo({
    "tsconfig.json": '{"compilerOptions":{"allowJs":true},"include":[]}\n',
    "packages/shared-config/tsconfig.base.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
    "packages/shared-config/src/decoy.ts": "export function decoySym(){ return 'd'; }\n",
    "apps/web/tsconfig.json": '{"extends":"../../packages/shared-config/tsconfig.base.json","compilerOptions":{"allowJs":true},"include":["src/**/*.ts"]}\n',
    "apps/web/src/consumer.ts": "import { decoySym } from '@/decoy';\nexport const use = decoySym;\n",
  });
  try {
    gitInit(dir, { commit: true });
    const imports = JSON.parse(run(dir, "--relates", "apps/web/src/consumer.ts", "--json").stdout).imports;
    assert.deepEqual(imports, ["packages/shared-config/src/decoy.ts"],
      "alias must resolve against the base config's own dir, not the child's");
  } finally { cleanup(dir); }
});

test("tsconfig extends: a same-named local file must not shadow the true base target", () => {
  const dir = makeRepo({
    "tsconfig.json": '{"compilerOptions":{"allowJs":true},"include":[]}\n',
    "packages/shared-config/tsconfig.base.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
    "packages/shared-config/src/decoy.ts": "export function decoySym(){ return 'shared'; }\n",
    "apps/web/tsconfig.json": '{"extends":"../../packages/shared-config/tsconfig.base.json","compilerOptions":{"allowJs":true},"include":["src/**/*.ts"]}\n',
    "apps/web/src/decoy.ts": "export function decoySym(){ return 'WRONG local'; }\n",
    "apps/web/src/consumer.ts": "import { decoySym } from '@/decoy';\nexport const use = decoySym;\n",
  });
  try {
    gitInit(dir, { commit: true });
    const imports = JSON.parse(run(dir, "--relates", "apps/web/src/consumer.ts", "--json").stdout).imports;
    assert.deepEqual(imports, ["packages/shared-config/src/decoy.ts"],
      "must not wire the edge to the coincidentally same-named local file");
  } finally { cleanup(dir); }
});

test("non-ASCII filenames survive git ls-files and appear in the map with edges", () => {
  const dir = makeRepo({
    "src/café.ts": "export function greet(){ return 'hi'; }\n",
    "src/index.ts": "import { greet } from './café';\nexport const x = greet();\n",
  });
  try {
    gitInit(dir, { commit: true });
    const files = JSON.parse(run(dir, "--map", "--json").stdout).files;
    const names = files.map((f) => f.file);
    assert.ok(names.includes("src/café.ts"), "the non-ASCII file must be in the map");
    // and its edge must resolve (index.ts depends on it)
    const rel = JSON.parse(run(dir, "--relates", "src/café.ts", "--json").stdout);
    assert.ok(rel.dependents.includes("src/index.ts"), "the non-ASCII file's importer must be tracked");
  } finally { cleanup(dir); }
});
