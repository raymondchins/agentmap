// SPDX-License-Identifier: MIT
// Vue SFC script-block extraction — quote-aware open-tag matcher.
//
// The pre-fix regex `<script(\s[^>]*)?>` used a greedy `[^>]*` for the attribute
// region. That terminates the opening tag at the FIRST `>` character, even
// when that `>` is INSIDE a quoted attribute value. The Vue 3 idiom
// `<script setup lang="ts" generic="T extends Record<string, unknown>">` has
// exactly that: a `>` inside the `generic="..."` value. With the old regex,
// the tag was terminated at the inner `>`, leaving the body shifted by those
// characters and corrupting what ts-morph sees.
//
// The fix replaces the open-tag matcher with a quote-aware regex: every
// attribute is required to be either a bareword (`setup`) or fully quoted
// (`name="value"` or `name='value'`). Attribute values are then allowed to
// contain `>` freely because the quoted region is matched as `[^"]*` or
// `[^']*` up to the matching close-quote.
//
// These tests lock in the new contract: a Vue 3 typed-generic SFC must be
// indexed under its real `.vue` path with the generic-typed body intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, cleanup } from "../helpers.mjs";
import { TSCONFIG, LIB_FORMAT, vueJson, leakedVirtualPaths } from "./fixtures.mjs";

test("generic-attrs: <script setup generic=\"T extends ...\"> is parsed with generic value preserved", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/TypedTable.vue": [
      `<script setup lang="ts" generic="T extends Record<string, unknown>">`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const n = FORMAT_VERSION;`,
      `const rows: T[] = [];`,
      `export function pickOne(): T { return rows[0] as T; }`,
      `</script>`,
    ].join("\n"),
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const f = json.files["src/components/TypedTable.vue"];
  assert.ok(f,
    `TypedTable.vue missing — open-tag matcher likely failed to handle > inside generic value. files: ${Object.keys(json.files).join(", ")}`);
  assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)),
    `imports missing — body may have been corrupted: ${JSON.stringify(f.imports)}`);
  assert.ok(f.exports.some((e) => e.name === "pickOne"),
    `pickOne export missing — body may have been corrupted: ${JSON.stringify(f.exports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("generic-attrs: <script generic='T, U'> with single quotes also works", () => {
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/PairView.vue": [
      `<script setup lang='ts' generic='K extends string, V extends number'>`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const n = FORMAT_VERSION;`,
      `export function take(k: K, v: V): [K, V] { return [k, v]; }`,
      `</script>`,
    ].join("\n"),
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  const f = json.files["src/components/PairView.vue"];
  assert.ok(f,
    `PairView.vue missing — single-quoted generic attr not parsed. files: ${Object.keys(json.files).join(", ")}`);
  assert.ok(f.exports.some((e) => e.name === "take"),
    `take export missing: ${JSON.stringify(f.exports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("generic-attrs: unquoted or malformed script tag is NOT silently misparsed", () => {
  // Sanity: if the open-tag matcher rejects a malformed tag (no proper
  // quoting), the SFC is OMITTED from the map rather than corrupting the
  // body. Better to lose one SFC than to silently include garbage.
  const dir = makeRepo({
    ...TSCONFIG, ...LIB_FORMAT,
    "src/components/Malformed.vue": [
      `<script setup generic=T extends Record<string, unknown>>`,  // unquoted value — invalid
      `export const z = 1;`,
      `</script>`,
    ].join("\n"),
  });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  // Either omitted entirely, or present without leaking virtual paths.
  // Both are acceptable outcomes (the contract is "no silent corruption").
  if (json.files["src/components/Malformed.vue"]) {
    assert.equal(leakedVirtualPaths(json).length, 0,
      `virtual path leaked from malformed SFC: ${JSON.stringify(json.files["src/components/Malformed.vue"])}`);
  }
  cleanup(dir);
});
