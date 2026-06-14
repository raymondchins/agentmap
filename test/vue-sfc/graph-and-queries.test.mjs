// SPDX-License-Identifier: MIT
// Vue SFC graph integrity + query-command behavior.
//
// Builds a realistic multi-SFC project and exercises: --find, --relates,
// --map, --symbols, --hubs, --any, --print — asserting each surfaces real
// `.vue` paths and never leaks virtual ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, cleanup, run } from "../helpers.mjs";
import { VUE_PROJECT, vueJson, leakedVirtualPaths } from "./fixtures.mjs";

function setup() {
  const dir = makeRepo(VUE_PROJECT);
  gitInit(dir, { commit: true });
  return dir;
}

// --find must return matches whose `file` is the REAL .vue path, never the
// virtual `.vue.ts` / `.vue.js`.
test("--find: symbol from Vue script returns real .vue path", () => {
  const dir = setup();
  const o = vueJson(dir, "--find", "useUserDisplayName");
  assert.ok(o.matches.length >= 1, `expected match, got: ${JSON.stringify(o.matches)}`);
  const m = o.matches[0];
  assert.equal(m.name, "useUserDisplayName");
  assert.equal(m.file, "src/components/UserCard.vue", `got: ${m.file}`);
  assert.equal(leakedVirtualPaths(o).length, 0);
  cleanup(dir);
});

test("--find: legacy Options-API named export from <script> is findable", () => {
  const dir = setup();
  const o = vueJson(dir, "--find", "legacyMarker");
  assert.ok(o.matches.some((m) => m.file === "src/components/LegacyButton.vue" && m.name === "legacyMarker"),
    `got: ${JSON.stringify(o.matches)}`);
  assert.equal(leakedVirtualPaths(o).length, 0);
  cleanup(dir);
});

test("--find: TypeScript typed const from <script lang=\"ts\"> is findable", () => {
  const dir = setup();
  const o = vueJson(dir, "--find", "kindLabel");
  assert.ok(o.matches.some((m) => m.file === "src/components/TypedCounter.vue" && m.name === "kindLabel"),
    `got: ${JSON.stringify(o.matches)}`);
  cleanup(dir);
});

// --relates to a .vue file must surface real .vue everywhere (file, related[]).
test("--relates: query for .vue file lists real .vue path + related files", () => {
  const dir = setup();
  const o = vueJson(dir, "--relates", "UserCard.vue");
  assert.match(o.file, /UserCard\.vue$/);
  assert.equal(o.file, "src/components/UserCard.vue");
  // The App.ts importer should be among related (random-walk reaches it).
  assert.ok(Array.isArray(o.related) && o.related.some((r) => r.file.endsWith("App.ts")),
    `expected App.ts among related, got: ${JSON.stringify(o.related)}`);
  assert.equal(leakedVirtualPaths(o).length, 0);
  cleanup(dir);
});

// --map digest must show real .vue paths in both file labels AND symbol rows.
test("--map: digest surfaces Vue files + symbols under real .vue paths", () => {
  const dir = setup();
  const o = vueJson(dir, "--map", "--tokens", "8192");
  assert.ok(Array.isArray(o.files), "files must be array");
  const vueFiles = o.files.filter((f) => f.file.endsWith(".vue"));
  assert.ok(vueFiles.length >= 1, `expected at least one .vue file in digest, got: ${JSON.stringify(o.files.map((f) => f.file))}`);
  assert.equal(leakedVirtualPaths(o).length, 0);
  cleanup(dir);
});

// --symbols (Aider-style ranking) must rank Vue-defined symbols with real paths.
test("--symbols: ranked symbols include Vue-script exports under real paths", () => {
  const dir = setup();
  const o = vueJson(dir, "--symbols", "80");
  const vueSyms = o.symbols.filter((s) => s.file.endsWith(".vue"));
  assert.ok(vueSyms.length >= 1, `expected >=1 Vue symbol, got: ${JSON.stringify(o.symbols.filter((s) => s.file.endsWith(".vue")))}`);
  assert.equal(leakedVirtualPaths(o).length, 0);
  cleanup(dir);
});

// --any router: a Vue-component-name query resolves to the file branch and
// names the real .vue path.
test("--any: query for Vue component name resolves to real .vue path", () => {
  const dir = setup();
  const o = vueJson(dir, "--any", "UserCard");
  // Either file-kind or structure-kind is fine; we care about the path string.
  const allFiles = o.kind === "file" ? [o.file] : (o.symbols || []).map((s) => s.file);
  assert.ok(
    allFiles.some((f) => f === "src/components/UserCard.vue"),
    `expected UserCard.vue in --any result, got: ${JSON.stringify(o)}`,
  );
  assert.equal(leakedVirtualPaths(o).length, 0);
  cleanup(dir);
});

// Non-JSON --hubs: PageRank-ranked hubs include Vue files under real paths.
test("--hubs (prose): mentions real .vue paths, no virtual leak", () => {
  const dir = setup();
  const r = run(dir, "--hubs");
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(!/\.vue\.(ts|js|mjs|cjs)/i.test(r.stdout), `virtual path leaked:\n${r.stdout}`);
  // UserCard.vue is imported by both App.ts AND Composite.vue → it should be a hub.
  assert.match(r.stdout, /UserCard\.vue/);
  cleanup(dir);
});
