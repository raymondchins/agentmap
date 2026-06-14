// SPDX-License-Identifier: MIT
// Vue SFC cache + freshness behavior.
//
// agentmap's freshness invariant: a dirty tree MUST trigger a rebuild. With
// Vue support, `.vue` files are now part of that contract. Editing a `.vue`
// file (without committing) must invalidate the cache and rebuild from disk.
// Additionally, the SCHEMA_VERSION bump (2 → 3) must invalidate any cache
// written by an older agentmap, and the non-git fingerprint path must detect
// `.vue` changes too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, writeFiles, gitInit, cleanup, run } from "../helpers.mjs";
import { TSCONFIG, LIB_FORMAT, SFC_SETUP_TS, vueJson, leakedVirtualPaths } from "./fixtures.mjs";

// Happy-path rebuild trigger: a committed repo builds clean; then we edit a
// `.vue` file's EXPORT (uncommitted) and re-query — the new export must appear.
test("freshness: dirty .vue triggers rebuild and surfaces edited export", () => {
  const dir = makeRepo({ ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS });
  gitInit(dir, { commit: true });
  const before = vueJson(dir, "--print");
  assert.ok(before.files["src/components/UserCard.vue"].exports.some((e) => e.name === "userCardMarker"));

  writeFiles(dir, {
    "src/components/UserCard.vue": [
      `<template><div>{{ v }}</div></template>`,
      `<script setup lang="ts">`,
      `import { formatUserName } from "../lib/format";`,
      `export const editedMarker = "after-edit";`,
      `export function useUserDisplayName(name: string) { return formatUserName(name); }`,
      `</script>`,
    ].join("\n"),
  });
  const after = vueJson(dir, "--print");
  const card = after.files["src/components/UserCard.vue"];
  assert.ok(card, ".vue file missing after rebuild");
  assert.ok(card.exports.some((e) => e.name === "editedMarker"),
    `edited export must surface after rebuild, got: ${JSON.stringify(card.exports)}`);
  // The PRE-edit marker is GONE from the file (overwrite, not append).
  assert.ok(!card.exports.some((e) => e.name === "userCardMarker"),
    `stale export leaked through cache after edit: ${JSON.stringify(card.exports)}`);
  assert.equal(leakedVirtualPaths(after).length, 0);
  cleanup(dir);
});

// dirtyCount() must count `.vue` files. We can observe this indirectly: if
// `.vue` weren't in the dirty regex, the post-edit rebuild above would NOT
// fire (the cache would serve the stale map). The previous test covers that
// functionally; this one is a stricter positive/negative pair.
test("freshness: clean .vue repo serves cache; dirty .vue forces rebuild", () => {
  const dir = makeRepo({ ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS });
  gitInit(dir, { commit: true });
  // Clean tree → warm cache. Same schema + same SHA + clean → identical content.
  const a = vueJson(dir, "--print");
  const b = vueJson(dir, "--print");
  assert.deepEqual(a.files["src/components/UserCard.vue"], b.files["src/components/UserCard.vue"]);
  // Now dirty ONLY a `.vue` file → cache must miss.
  writeFiles(dir, {
    "src/components/UserCard.vue": [
      `<template><div>{{ v }}</div></template>`,
      `<script setup lang="ts">`,
      `import { formatUserName } from "../lib/format";`,
      `export const secondEdit = "v2";`,
      `</script>`,
    ].join("\n"),
  });
  const c = vueJson(dir, "--print");
  assert.ok(c.files["src/components/UserCard.vue"].exports.some((e) => e.name === "secondEdit"),
    `dirty .vue must force rebuild (got stale cache): ${JSON.stringify(c.files["src/components/UserCard.vue"].exports)}`);
  cleanup(dir);
});

// Schema bump: a map written under schema 2 (old agentmap) must be ignored by
// the new agentmap (schema 3) and rebuilt from scratch. We simulate an old
// cache by hand-writing a schema-2 agentmap.json then running a query — the
// rebuild must drop the stale schema-2 content.
test("schema: old schema-2 cache is ignored and rebuilt (no stale serve)", () => {
  const dir = makeRepo({ ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS });
  gitInit(dir, { commit: true });
  // Hand-craft a fake schema-2 map that pretends UserCard.vue doesn't exist.
  const { writeFileSync, mkdirSync } = require("node:fs");
  const { resolve } = require("node:path");
  mkdirSync(resolve(dir, ".claude"), { recursive: true });
  writeFileSync(resolve(dir, ".claude/agentmap.json"), JSON.stringify({
    schema: 2, generatedSha: "deadbeef", dirty: 0, fileCount: 1,
    hubs: [], features: {}, rankedSymbols: [],
    files: { "stale-only.ts": { exports: [], imports: [], dependents: [], importedSymbols: {}, pagerank: 0 } },
  }));
  const o = vueJson(dir, "--print");
  // The stale entry must be gone, and the real .vue file must be present.
  assert.ok(!o.files["stale-only.ts"], "stale schema-2 entry leaked through");
  assert.ok(o.files["src/components/UserCard.vue"], "schema-2 cache not rebuilt (missing real .vue)");
  cleanup(dir);
});

// Non-git fingerprint path: `.vue` changes must invalidate the non-git
// fingerprint so the cache is not served stale. We init a repo WITHOUT git
// and query twice — then edit the .vue — and confirm the rebuild picks it up.
test("non-git: .vue edit invalidates source fingerprint (non-git cache path)", () => {
  const dir = makeRepo({ ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS });
  // NOTE: deliberately NO gitInit — sha === "" path.
  const a = vueJson(dir, "--print");
  assert.ok(a.files["src/components/UserCard.vue"], ".vue missing on first non-git build");
  writeFiles(dir, {
    "src/components/UserCard.vue": [
      `<template><div>{{ v }}</div></template>`,
      `<script setup lang="ts">`,
      `export const nonGitEdit = "ng";`,
      `</script>`,
    ].join("\n"),
  });
  const b = vueJson(dir, "--print");
  assert.ok(b.files["src/components/UserCard.vue"].exports.some((e) => e.name === "nonGitEdit"),
    `non-git fingerprint must detect .vue change, got: ${JSON.stringify(b.files["src/components/UserCard.vue"].exports)}`);
  cleanup(dir);
});

// tiny helper: createRequire keeps this sync and works on Node 18+ ESM.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
