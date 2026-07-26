// Which package.json field names the SOURCE, in a repo where the build output
// isn't checked in.
//
// A workspace package declares its PUBLISHED entry — `main: "dist/index.js"` —
// and `dist/` is gitignored. Resolving `main` first therefore pointed at a file
// that is not in the repo, and the cross-package edge silently disappeared: the
// single most valuable thing a repo map knows about a monorepo, absent, with no
// warning. Measured before the fix, all reporting ZERO dependents:
//
//   main: dist/index.js                                  -> 0
//   exports: { ".": "./dist/index.js" }                  -> 0
//   main: dist/index.js + types: src/index.ts            -> 0   <- worst: declared
//
// The third is a plain correctness bug — TypeScript resolves `types`/`typings`
// ahead of `main`, and agentmap never read either field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const repo = (corePkg, extra = {}) => ({
  "packages/core/package.json": corePkg,
  "packages/core/src/index.ts": "export function helper() { return 1; }\n",
  "packages/app/package.json": '{ "name": "@acme/app" }',
  "packages/app/src/main.ts": 'import { helper } from "@acme/core";\nexport const v = helper();\n',
  ...extra,
});

const dependentsOf = (dir, file) =>
  JSON.parse(run(dir, "--relates", file, "--json").stdout).dependents;

const SHAPES = {
  "types points at source, main at dist":
    '{ "name": "@acme/core", "main": "dist/index.js", "types": "src/index.ts" }',
  "typings (legacy spelling) points at source":
    '{ "name": "@acme/core", "main": "dist/index.js", "typings": "src/index.ts" }',
  "exports types condition points at source":
    '{ "name": "@acme/core", "exports": { ".": { "types": "./src/index.ts", "import": "./dist/index.js" } } }',
  "only main, pointing at unbuilt dist":
    '{ "name": "@acme/core", "main": "dist/index.js" }',
  "only exports, pointing at unbuilt dist":
    '{ "name": "@acme/core", "exports": { ".": "./dist/index.js" } }',
};

for (const [name, corePkg] of Object.entries(SHAPES)) {
  test(`workspace entry: ${name}`, () => {
    const dir = makeRepo(repo(corePkg));
    try {
      gitInit(dir, { commit: true });
      assert.deepEqual(
        dependentsOf(dir, "packages/core/src/index.ts"),
        ["packages/app/src/main.ts"],
        `cross-package edge lost for: ${name}`,
      );
    } finally { cleanup(dir); }
  });
}

test("a declared entry outranks the ./src/index fallback", () => {
  // The fallback exists only for packages whose declared entry isn't in the repo.
  // A package that really does ship from elsewhere must be unaffected — otherwise
  // the convenience heuristic starts inventing edges.
  const dir = makeRepo({
    "packages/core/package.json": '{ "name": "@acme/core", "main": "lib/entry.ts" }',
    "packages/core/lib/entry.ts": 'export function helper() { return "LIB"; }\n',
    "packages/core/src/index.ts": 'export function helper() { return "SRC"; }\n',
    "packages/app/package.json": '{ "name": "@acme/app" }',
    "packages/app/src/main.ts": 'import { helper } from "@acme/core";\nexport const v = helper();\n',
  });
  try {
    gitInit(dir, { commit: true });
    assert.deepEqual(dependentsOf(dir, "packages/core/lib/entry.ts"), ["packages/app/src/main.ts"]);
    assert.deepEqual(dependentsOf(dir, "packages/core/src/index.ts"), [],
      "the ./src/index fallback overrode a declared entry that resolves");
  } finally { cleanup(dir); }
});

test("the fallback does not invent a package that does not exist", () => {
  // Guards the same boundary from the other side: a bare import of a name no
  // package.json in the repo declares must still produce nothing.
  const dir = makeRepo({
    "packages/core/package.json": '{ "name": "@acme/core", "main": "dist/index.js" }',
    "packages/core/src/index.ts": "export function helper() { return 1; }\n",
    "packages/app/package.json": '{ "name": "@acme/app" }',
    "packages/app/src/main.ts": 'import { nope } from "@totally/unrelated";\nexport const v = nope;\n',
  });
  try {
    gitInit(dir, { commit: true });
    assert.deepEqual(dependentsOf(dir, "packages/core/src/index.ts"), []);
  } finally { cleanup(dir); }
});
