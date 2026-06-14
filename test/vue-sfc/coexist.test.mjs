// SPDX-License-Identifier: MIT
// Vue SFC + TS/JS coexistence — extensionless resolution priority.
//
// When a `.vue` file and a `.ts`/`.js` file share the same basename in the
// same directory, an EXTENSIONLESS specifier (`import X from "./Comp"`) must
// resolve to the TS/JS file, NOT the `.vue` file. This preserves the existing
// TS/JS-first resolution priority — Vue support is strictly ADDITIVE and must
// never shadow a real TS/JS module of the same name.
//
// Conversely, an explicit `./Comp.vue` specifier still resolves to the `.vue`
// file even when a same-name `.ts` exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, cleanup } from "../helpers.mjs";
import { TSCONFIG, LIB_FORMAT, vueJson, leakedVirtualPaths } from "./fixtures.mjs";

test("coexist: extensionless ./Comp → Comp.ts when both .vue and .ts exist (TS wins)", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/Comp.vue": [
      `<script setup lang="ts">`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const fromVue = "vue";`,
      `export const n = FORMAT_VERSION;`,
      `</script>`,
    ].join("\n"),
    "src/components/Comp.ts": `export const fromTs = "ts";`,
    "src/App.ts": `import Comp from "./components/Comp";\nexport const Z = Comp;`,
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("Comp.ts")),
    `extensionless must resolve to Comp.ts, got: ${JSON.stringify(app.imports)}`);
  assert.ok(!app.imports.some((i) => i.endsWith("Comp.vue")),
    `extensionless must NOT resolve to Comp.vue when Comp.ts exists`);
  // Both files independently indexed.
  assert.ok(json.files["src/components/Comp.ts"], "Comp.ts must be indexed");
  assert.ok(json.files["src/components/Comp.vue"], "Comp.vue must be indexed on its own");
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("coexist: explicit ./Comp.vue still resolves to .vue when Comp.ts also exists", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/Comp.vue": [
      `<script setup lang="ts">`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const fromVue = "vue";`,
      `</script>`,
    ].join("\n"),
    "src/components/Comp.ts": `export const fromTs = "ts";`,
    "src/App.ts": `import Comp from "./components/Comp.vue";\nexport const Z = Comp;`,
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("Comp.vue")),
    `explicit .vue specifier must resolve to Comp.vue, got: ${JSON.stringify(app.imports)}`);
  assert.ok(!app.imports.some((i) => i.endsWith("Comp.ts")),
    `explicit .vue specifier must NOT resolve to Comp.ts`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("coexist: extensionless ./Comp → Comp.vue when NO same-name TS/JS exists", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/Comp.vue": [
      `<script setup lang="ts">`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const fromVue = "vue";`,
      `</script>`,
    ].join("\n"),
    "src/App.ts": `import Comp from "./components/Comp";\nexport const Z = Comp;`,
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const app = json.files["src/App.ts"];
  assert.ok(app.imports.some((i) => i.endsWith("Comp.vue")),
    `extensionless must fall back to Comp.vue when no TS/JS of same name, got: ${JSON.stringify(app.imports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});
