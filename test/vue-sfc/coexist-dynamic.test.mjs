// SPDX-License-Identifier: MIT
// Vue SFC + TS/JS coexistence — dynamic-import / require / side-effect paths.
//
// `resolveSpec` in agentmap.mjs is ONLY invoked for specifiers that ts-morph's
// getModuleSpecifierSourceFile() cannot resolve directly: side-effect imports
// (`import "./x"`) and dynamic `import()`/`require()` calls. Static `import X
// from "./x"` always goes through ts-morph first, so it never hits resolveSpec
// and is covered by coexist.test.mjs.
//
// The bug fixed by this commit: previously the extensionless-`.vue` fallback
// (`vueReal[`${baseAbs}.vue`]`) ran BEFORE the TS/JS loop in resolveSpec. That
// meant for `import("./Comp")` (dynamic) with both `Comp.ts` and `Comp.vue`
// present, the resolver would pick `Comp.vue` — overriding the TS/JS-first
// priority that coexist.test.mjs locks in for static imports. The static path
// was unaffected, so the bug was invisible to coexist.test.mjs.
//
// After the fix, resolveSpec tries the TS/JS loop FIRST and only falls back
// to `.vue` when no TS/JS shadow exists. This file locks in that contract for
// the dynamic paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, cleanup } from "../helpers.mjs";
import { TSCONFIG, LIB_FORMAT, vueJson, leakedVirtualPaths } from "./fixtures.mjs";

test("coexist-dynamic: import(\"./Comp\") → Comp.ts when both .vue and .ts exist (TS wins)", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/Comp.vue": [
      `<script setup lang="ts">`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const fromVue = "vue";`,
      `</script>`,
    ].join("\n"),
    "src/components/Comp.ts": `export const fromTs = "ts";`,
    "src/App.ts": [
      `async function load() { const m = await import("./components/Comp"); return m; }`,
      `load();`,
    ].join("\n"),
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("Comp.ts")),
    `dynamic import() must resolve to Comp.ts when shadow exists, got: ${JSON.stringify(app.imports)}`);
  assert.ok(!app.imports.some((i) => i.endsWith("Comp.vue")),
    `dynamic import() must NOT resolve to Comp.vue when Comp.ts shadow exists`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("coexist-dynamic: require(\"./Comp\") → Comp.ts when both .vue and .ts exist (TS wins)", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/Comp.vue": [
      `<script setup lang="ts">`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const fromVue = "vue";`,
      `</script>`,
    ].join("\n"),
    "src/components/Comp.ts": `export const fromTs = "ts";`,
    "src/App.ts": [
      `const m = require("./components/Comp");`,
      `export const Z = m;`,
    ].join("\n"),
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("Comp.ts")),
    `require() must resolve to Comp.ts when shadow exists, got: ${JSON.stringify(app.imports)}`);
  assert.ok(!app.imports.some((i) => i.endsWith("Comp.vue")),
    `require() must NOT resolve to Comp.vue when Comp.ts shadow exists`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("coexist-dynamic: side-effect import \"./Comp\" → Comp.ts when both .vue and .ts exist (TS wins)", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/Comp.vue": [
      `<script setup lang="ts">`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const fromVue = "vue";`,
      `</script>`,
    ].join("\n"),
    "src/components/Comp.ts": `export const fromTs = "ts";`,
    "src/App.ts": [
      `import "./components/Comp";`,  // side-effect, no bindings
      `export const Z = 1;`,
    ].join("\n"),
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("Comp.ts")),
    `side-effect import must resolve to Comp.ts when shadow exists, got: ${JSON.stringify(app.imports)}`);
  assert.ok(!app.imports.some((i) => i.endsWith("Comp.vue")),
    `side-effect import must NOT resolve to Comp.vue when Comp.ts shadow exists`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("coexist-dynamic: import(\"./Comp\") → Comp.vue when NO same-name TS/JS exists (fallback)", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/Comp.vue": [
      `<script setup lang="ts">`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const fromVue = "vue";`,
      `</script>`,
    ].join("\n"),
    "src/App.ts": [
      `async function load() { const m = await import("./components/Comp"); return m; }`,
      `load();`,
    ].join("\n"),
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("Comp.vue")),
    `dynamic import() must fall back to Comp.vue when no TS/JS shadow, got: ${JSON.stringify(app.imports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});
