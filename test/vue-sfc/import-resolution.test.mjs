// SPDX-License-Identifier: MIT
// Vue SFC import resolution + graph edges.
//
// Covers: exact `.vue` specifiers, extensionless specifiers resolving to a
// `.vue` file, relative `../` paths, SFC→SFC imports, dynamic import(),
// `require()`, and the TS/JS→.vue edge that's the most common real-world case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, cleanup } from "../helpers.mjs";
import { TSCONFIG, LIB_FORMAT, SFC_SETUP_TS, SFC_IMPORTS_SFC, vueJson, leakedVirtualPaths } from "./fixtures.mjs";

// TS file imports a `.vue` via the EXACT specifier `./UserCard.vue`. The edge
// target in the map MUST be `UserCard.vue` (real path), and UserCard.vue's
// `dependents` list MUST contain App.ts.
test("exact specifier: import X from \"./C.vue\" → edge to real .vue + dependent recorded", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS,
    "src/App.ts": `import UserCard from "./components/UserCard.vue";\nexport const appUsesUserCard = UserCard;`,
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app, "App.ts missing");
  assert.ok(app.imports.some((i) => i.endsWith("UserCard.vue")),
    `App.ts imports must include UserCard.vue, got: ${JSON.stringify(app.imports)}`);
  const card = json.files["src/components/UserCard.vue"];
  assert.ok(card.dependents.some((d) => d.endsWith("App.ts")),
    `UserCard.vue dependents must include App.ts, got: ${JSON.stringify(card.dependents)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

// Extensionless specifier `./UserCard` that happens to resolve to a `.vue`
// file (no `.ts`/`.js` of the same name). Resolver must try `.vue` after the
// standard extension list and land on the real path.
test("extensionless: import X from \"./UserCard\" resolves to UserCard.vue when no TS shadow", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS,
    "src/App.ts": `import UserCard from "./components/UserCard";\nexport const X = UserCard;`,
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("UserCard.vue")),
    `extensionless resolution must land on UserCard.vue, got: ${JSON.stringify(app.imports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

// Relative `../` path: a component nested one level deeper reaches `lib/` via
// `../../lib/...`. Ensures path-join in resolveSpec handles `..` correctly for
// both the SFC's own imports AND imports INTO the SFC.
test("relative up-dir: SFC in nested dir imports via ../lib", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/features/deep/UserCard.vue": [
      `<template><div>{{ n }}</div></template>`,
      `<script setup lang="ts">`,
      `import { FORMAT_VERSION } from "../../lib/format";`,
      `export const deepMarker = "deep";`,
      `export const n = FORMAT_VERSION;`,
      `</script>`,
    ].join("\n"),
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const f = json.files["src/features/deep/UserCard.vue"];
  assert.ok(f, "nested UserCard.vue missing");
  assert.ok(f.imports.some((i) => i.endsWith("lib/format.ts")),
    `expected import of lib/format.ts, got: ${JSON.stringify(f.imports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

// SFC imports another SFC. Both sides are virtual sources; the edge must still
// land on the REAL importer→imported paths.
test("SFC→SFC: Composite.vue imports UserCard.vue, edge lands on real paths", () => {
  const dir = makeRepo({ ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS, ...SFC_IMPORTS_SFC });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const comp = json.files["src/components/Composite.vue"];
  assert.ok(comp, "Composite.vue missing");
  assert.ok(comp.imports.some((i) => i.endsWith("UserCard.vue")),
    `Composite.vue must import UserCard.vue, got: ${JSON.stringify(comp.imports)}`);
  const card = json.files["src/components/UserCard.vue"];
  assert.ok(card.dependents.some((d) => d.endsWith("Composite.vue")),
    `UserCard.vue dependents must include Composite.vue, got: ${JSON.stringify(card.dependents)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

// Dynamic import("./C.vue") — async module load. Must form the same edge as a
// static import (current behavior for dynamic TS/JS imports).
test("dynamic: await import(\"./UserCard.vue\") forms an edge", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS,
    "src/App.ts": `export async function load() { return (await import("./components/UserCard.vue")).default; }`,
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("UserCard.vue")),
    `dynamic import must form edge to UserCard.vue, got: ${JSON.stringify(app.imports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

// require("./C.vue") inside a `.ts` file — CommonJS dynamic resolution path.
test("commonjs: require(\"./UserCard.vue\") forms an edge", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS,
    "src/App.ts": `export const X = require("./components/UserCard.vue");`,
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("UserCard.vue")),
    `require must form edge to UserCard.vue, got: ${JSON.stringify(app.imports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

// Side-effect import: `import "./C.vue"` (no bindings). Must still form an edge
// because the module is loaded at runtime.
test("side-effect: import \"./UserCard.vue\" (no bindings) forms an edge", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS,
    "src/App.ts": `import "./components/UserCard.vue";\nexport const X = 1;`,
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("UserCard.vue")),
    `side-effect import must form edge to UserCard.vue, got: ${JSON.stringify(app.imports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});
