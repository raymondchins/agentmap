// Monorepo tsconfig shapes — locking in behaviour that was believed broken.
//
// ROADMAP 1B carried "tsconfig `references` (project references) are absent —
// THE defining monorepo primitive", justified by the word `references` not
// appearing in agentmap.mjs. Measuring it showed the premise was wrong twice:
//
//   1. Project references are NOT a module-resolution mechanism. They control
//      build order and declaration output. TypeScript resolves cross-package
//      imports via relative paths, `paths`, or node_modules/workspaces — all
//      three of which agentmap already handles. Confirmed against TypeScript's
//      own `ts.resolveModuleName`: a package-name import with references but no
//      `paths` and no package.json fails in tsc too (TS2307), so returning no
//      edge there is CORRECT, not a gap.
//   2. A narrow or solution-style tsconfig `include` never limited the file set
//      anyway — makeProject loads tsconfig for compiler options only, then adds
//      everything from `git ls-files` that `include` missed.
//
// These tests exist so that stays true. The failure they guard is a future
// change to file discovery quietly reintroducing "the root tsconfig decides what
// gets indexed", which would silently empty out every monorepo map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// core + app + a root-level file, with app importing core relatively.
const files = (rootTsconfig) => ({
  ...(rootTsconfig === null ? {} : { "tsconfig.json": rootTsconfig }),
  "src/root.ts": "export const only = 1;\n",
  "packages/core/src/index.ts": "export function helper() { return 1; }\n",
  "packages/app/src/main.ts":
    'import { helper } from "../../core/src/index";\nexport const v = helper();\n',
});

const SHAPES = {
  "solution-style (files:[] + references)":
    '{ "files": [], "references": [{"path":"./packages/core"},{"path":"./packages/app"}] }',
  "narrow include (misses packages/ entirely)":
    '{ "compilerOptions": {}, "include": ["src"] }',
  "partial include (one package only)":
    '{ "compilerOptions": {}, "include": ["src", "packages/app"] }',
  "no tsconfig at all": null,
};

for (const [name, cfg] of Object.entries(SHAPES)) {
  test(`monorepo: ${name} still indexes the whole repo`, () => {
    const dir = makeRepo(files(cfg));
    try {
      gitInit(dir, { commit: true });
      const r = JSON.parse(run(dir, "--relates", "packages/core/src/index.ts", "--json").stdout);
      assert.equal(
        r.dependents.length, 1,
        `cross-package edge lost under "${name}" — file discovery is being limited by tsconfig again`,
      );
      assert.equal(r.dependents[0], "packages/app/src/main.ts");
    } finally { cleanup(dir); }
  });
}

test("monorepo: package-name import resolves via root tsconfig paths", () => {
  const dir = makeRepo({
    "tsconfig.json": '{ "files": [], "references": [{"path":"./packages/core"}], "compilerOptions": { "baseUrl": ".", "paths": { "@acme/core": ["packages/core/src/index.ts"] } } }',
    "packages/core/src/index.ts": "export function helper() { return 1; }\n",
    "packages/app/src/main.ts": 'import { helper } from "@acme/core";\nexport const v = helper();\n',
  });
  try {
    gitInit(dir, { commit: true });
    const r = JSON.parse(run(dir, "--relates", "packages/core/src/index.ts", "--json").stdout);
    assert.deepEqual(r.dependents, ["packages/app/src/main.ts"]);
  } finally { cleanup(dir); }
});

test("monorepo: package-name import resolves via the workspace package.json", () => {
  const dir = makeRepo({
    "tsconfig.json": '{ "files": [], "references": [{"path":"./packages/core"}] }',
    "package.json": '{ "name": "root", "private": true, "workspaces": ["packages/*"] }',
    "packages/core/package.json": '{ "name": "@acme/core", "main": "src/index.ts" }',
    "packages/core/src/index.ts": "export function helper() { return 1; }\n",
    "packages/app/src/main.ts": 'import { helper } from "@acme/core";\nexport const v = helper();\n',
  });
  try {
    gitInit(dir, { commit: true });
    const r = JSON.parse(run(dir, "--relates", "packages/core/src/index.ts", "--json").stdout);
    assert.deepEqual(r.dependents, ["packages/app/src/main.ts"]);
  } finally { cleanup(dir); }
});

test("monorepo: no edge is fabricated when TypeScript itself cannot resolve", () => {
  // references + no paths + no package.json = TS2307 in tsc. Inventing an edge
  // here would be worse than missing one: it would be a wrong answer presented
  // with the same confidence as a right one.
  const dir = makeRepo({
    "tsconfig.json": '{ "files": [], "references": [{"path":"./packages/core"}] }',
    "packages/core/src/index.ts": "export function helper() { return 1; }\n",
    "packages/app/src/main.ts": 'import { helper } from "@acme/core";\nexport const v = helper();\n',
  });
  try {
    gitInit(dir, { commit: true });
    const r = JSON.parse(run(dir, "--relates", "packages/core/src/index.ts", "--json").stdout);
    assert.equal(r.dependents.length, 0, "fabricated an edge tsc would reject");
  } finally { cleanup(dir); }
});
