// SPDX-License-Identifier: MIT
// Workspace cross-package resolution (pnpm/npm/yarn workspaces). A BARE import of
// a workspace package name (`@acme/core`) — or a subpath of it — must form a real
// dependency edge to that package's SOURCE, so blast-radius (--relates) + hub
// ranking work across package boundaries. Also proves a repo WITHOUT named
// workspace packages is unaffected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// ---- Fixtures --------------------------------------------------------------

// pnpm-style: packages/core ('@acme/core', src/index.ts) + packages/web importing it.
function bareFixture() {
  return {
    "pnpm-workspace.yaml": `packages:\n  - "packages/*"\n`,
    "package.json": JSON.stringify({ name: "root", private: true }),
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", version: "1.0.0", main: "src/index.ts" }),
    "packages/core/src/index.ts": `export function coreSymbol() { return "core"; }\n`,
    "packages/web/package.json": JSON.stringify({ name: "@acme/web", version: "1.0.0" }),
    "packages/web/src/app.ts": `import { coreSymbol } from "@acme/core";\nexport const app = coreSymbol();\n`,
  };
}

// Subpath via an "exports" subpath map: '@acme/ui/button' → src/components/button.ts,
// and bare '@acme/ui' via an "exports"."." conditions object → src/index.ts.
function subpathFixture() {
  return {
    "package.json": JSON.stringify({ name: "root", private: true }),
    "packages/ui/package.json": JSON.stringify({
      name: "@acme/ui", version: "1.0.0",
      exports: { ".": { import: "./src/index.ts" }, "./button": "./src/components/button.ts" },
    }),
    "packages/ui/src/index.ts": `export function uiRoot() { return "ui"; }\n`,
    "packages/ui/src/components/button.ts": `export function Button() { return "btn"; }\n`,
    "packages/app/package.json": JSON.stringify({ name: "@acme/app", version: "1.0.0" }),
    "packages/app/src/root.ts": `import { uiRoot } from "@acme/ui";\nexport const r = uiRoot();\n`,
    "packages/app/src/btn.ts": `import { Button } from "@acme/ui/button";\nexport const b = Button();\n`,
  };
}

// A workspace package with NO "exports" map where source mirrors the import path:
// '@acme/util/helpers' → packages/util/helpers.ts (naive package-dir + subpath).
function naiveSubpathFixture() {
  return {
    "package.json": JSON.stringify({ name: "root", private: true }),
    "packages/util/package.json": JSON.stringify({ name: "@acme/util", version: "1.0.0", main: "index.ts" }),
    "packages/util/index.ts": `export function utilRoot() { return "u"; }\n`,
    "packages/util/helpers.ts": `export function helper() { return "h"; }\n`,
    "packages/app/package.json": JSON.stringify({ name: "@acme/app", version: "1.0.0" }),
    "packages/app/src/uses-util.ts": `import { helper } from "@acme/util/helpers";\nexport const x = helper();\n`,
  };
}

// ---- Triggering behavior ---------------------------------------------------

test("workspace: bare '@acme/core' import forms a cross-package dependent edge", () => {
  const dir = makeRepo(bareFixture());
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "packages/core/src/index.ts");
  assert.equal(r.status, 0, r.stderr);
  // The dependents line must name the importing package (the edge that was ZERO
  // before workspace resolution — proving blast-radius crosses the boundary).
  assert.match(r.stdout, /dependents \(1\): packages\/web\/src\/app\.ts/, r.stdout);
  cleanup(dir);
});

test("workspace: bare import via exports '.' conditions object resolves to source entry", () => {
  const dir = makeRepo(subpathFixture());
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "packages/ui/src/index.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dependents \(1\): packages\/app\/src\/root\.ts/, r.stdout);
  cleanup(dir);
});

test("workspace: subpath '@acme/ui/button' resolves via the exports subpath map", () => {
  const dir = makeRepo(subpathFixture());
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "packages/ui/src/components/button.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dependents \(1\): packages\/app\/src\/btn\.ts/, r.stdout);
  cleanup(dir);
});

test("workspace: subpath '@acme/util/helpers' resolves via naive package-dir + subpath (no exports map)", () => {
  const dir = makeRepo(naiveSubpathFixture());
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "packages/util/helpers.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dependents \(1\): packages\/app\/src\/uses-util\.ts/, r.stdout);
  cleanup(dir);
});

// ---- Non-triggering: must stay behaviorally unchanged ----------------------

test("non-workspace repo (no named package.json) is unaffected — normal relative edges only", () => {
  const dir = makeRepo({
    "src/lib/util.ts": `export function u() { return 1; }\n`,
    "src/app.ts": `import { u } from "./lib/util";\nexport const a = u();\n`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "src/lib/util.ts");
  assert.equal(r.status, 0, r.stderr);
  // The ordinary relative import still forms its edge…
  assert.match(r.stdout, /dependents \(1\): src\/app\.ts/, r.stdout);
  // …and nothing bare/workspace-shaped leaks in.
  assert.doesNotMatch(r.stdout, /@acme/, r.stdout);
  cleanup(dir);
});

test("bare import of a NON-workspace package name does not fabricate an edge", () => {
  // '@acme/core' package.json has a name but is imported by NOBODY; a stray bare
  // import of a package that isn't in the workspace ('lodash') must stay unresolved.
  const dir = makeRepo({
    "package.json": JSON.stringify({ name: "root", private: true }),
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", version: "1.0.0", main: "src/index.ts" }),
    "packages/core/src/index.ts": `export function coreSymbol() { return "core"; }\n`,
    "packages/web/package.json": JSON.stringify({ name: "@acme/web", version: "1.0.0" }),
    "packages/web/src/app.ts": `import _ from "lodash";\nexport const app = _;\n`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "packages/core/src/index.ts");
  assert.equal(r.status, 0, r.stderr);
  // No importer resolved through the workspace map (lodash isn't a workspace pkg,
  // and @acme/core is imported by no one).
  assert.match(r.stdout, /dependents \(0\): —/, r.stdout);
  cleanup(dir);
});
