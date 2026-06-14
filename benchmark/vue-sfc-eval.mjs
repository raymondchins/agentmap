#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Vue SFC eval — runs the agentmap CLI against a realistic Vue project and
// verifies the documented Vue SFC contracts. Prints a single summary line:
//
//   Vue SFC eval: N/N passed (100%)
//
// Used as PR evidence that the Vue SFC feature works end-to-end. This is NOT
// a replacement for the in-tree test suite (test/vue-sfc/*.test.mjs) — it is
// a fast, dependency-light smoke check that mirrors the black-box CLI surface.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const AGENTMAP = new URL("../agentmap.mjs", import.meta.url).pathname;
const VIRTUAL_RE = /\.vue\.(ts|js|mjs|cjs|tsx|jsx)$/i;

// Realistic multi-file Vue project: setup+ts, options-js, options-ts, dual
// script, template-only (omitted), external-script (skipped), SFC→SFC, plus
// the canonical App.ts that wires them together.
const PROJECT = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts", "**/*.vue", "src/**/*"] }),
  "src/lib/format.ts": `export function formatUserName(n: string) { return n.trim(); }\nexport const FORMAT_VERSION = 1;\nexport interface User { id: number; name: string; }`,
  "src/lib/validate.ts": `export function isEmail(s: string) { return s.includes("@"); }`,
  "src/components/UserCard.vue": [
    `<template><article>{{ displayName }}</article></template>`,
    `<script setup lang="ts">`,
    `import { computed } from "vue";`,
    `import { formatUserName } from "../lib/format";`,
    `import type { User } from "../lib/format";`,
    `const props = defineProps<{ user: User; kind: string }>();`,
    `defineEmits<{ (e: "select", id: number): void }>();`,
    `export const userCardMarker = "vue-sfc";`,
    `export function useUserDisplayName() { return computed(() => formatUserName(props.user.name)).value; }`,
    `</script>`,
  ].join("\n"),
  "src/components/LegacyButton.vue": [
    `<template><button @click="onClick"><slot /></button></template>`,
    `<script>`,
    `import { FORMAT_VERSION } from "../lib/format";`,
    `export const legacyMarker = "options";`,
    `export default { name: "LegacyButton", methods: { onClick() { this.$emit("click", FORMAT_VERSION); } } };`,
    `</script>`,
  ].join("\n"),
  "src/components/TypedCounter.vue": [
    `<template><div>{{ count }}</div></template>`,
    `<script lang="ts">`,
    `import { FORMAT_VERSION } from "../lib/format";`,
    `export const typedCounterMarker = "ts-options";`,
    `export const initialCount: number = FORMAT_VERSION;`,
    `</script>`,
  ].join("\n"),
  "src/components/EmailField.vue": [
    `<template><input :value="value" /></template>`,
    `<script setup lang="ts">`,
    `import { isEmail } from "../lib/validate";`,
    `export const emailFieldMarker = "email";`,
    `export function valid(s: string) { return isEmail(s); }`,
    `</script>`,
  ].join("\n"),
  "src/components/Composite.vue": [
    `<template><UserCard /></template>`,
    `<script setup lang="ts">`,
    `import UserCard from "./UserCard.vue";`,
    `export const compositeMarker = "composite";`,
    `export const inner = UserCard;`,
    `</script>`,
  ].join("\n"),
  "src/components/AsyncProfile.vue": [
    `<template><div>{{ data }}</div></template>`,
    `<script setup lang="ts">`,
    `import { FORMAT_VERSION } from "../lib/format";`,
    `export const asyncMarker = "await";`,
    `const data = await Promise.resolve(FORMAT_VERSION);`,
    `</script>`,
  ].join("\n"),
  "src/components/PureTemplate.vue": [
    `<template><p>Static only.</p></template>`,
    `<style scoped>p { color: blue; }</style>`,
  ].join("\n"),
  "src/App.ts": [
    `import UserCard from "./components/UserCard.vue";`,
    `import LegacyButton from "./components/LegacyButton.vue";`,
    `export const appUsesUserCard = UserCard;`,
    `export const appUsesLegacy = LegacyButton;`,
  ].join("\n"),
};

function sh(args, dir) {
  try {
    return execFileSync("node", [AGENTMAP, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { _error: e.stderr?.toString() || e.message, _exit: e.status };
  }
}

function runJson(args, dir) {
  const out = sh(["--json", ...args], dir);
  if (typeof out !== "string") throw new Error(`non-string stdout: ${JSON.stringify(out)}`);
  return JSON.parse(out);
}

// Each check is [name, fn(dir) => void]. Throwing = fail; returning = pass.
const CHECKS = [
  ["UserCard.vue present under real path", (d) => {
    const o = runJson(["--print"], d);
    assert.ok("src/components/UserCard.vue" in o.files, `keys: ${Object.keys(o.files).join(", ")}`);
  }],
  ["no virtual path in --print JSON", (d) => {
    const o = runJson(["--print"], d);
    const leaks = JSON.stringify(o).match(VIRTUAL_RE) || [];
    assert.equal(leaks.length, 0, `leaks: ${leaks.join(", ")}`);
  }],
  ["<script setup lang=ts> import detected", (d) => {
    const o = runJson(["--print"], d);
    const f = o.files["src/components/UserCard.vue"];
    assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)), `imports: ${JSON.stringify(f.imports)}`);
  }],
  ["plain <script> import detected", (d) => {
    const o = runJson(["--print"], d);
    const f = o.files["src/components/LegacyButton.vue"];
    assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)));
  }],
  ["<script lang=ts> (no setup) import detected", (d) => {
    const o = runJson(["--print"], d);
    const f = o.files["src/components/TypedCounter.vue"];
    assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)));
  }],
  ["App.ts imports UserCard.vue (exact specifier)", (d) => {
    const o = runJson(["--print"], d);
    assert.ok(o.files["src/App.ts"].imports.some((i) => i.endsWith("UserCard.vue")));
  }],
  ["UserCard.vue lists App.ts as dependent", (d) => {
    const o = runJson(["--print"], d);
    assert.ok(o.files["src/components/UserCard.vue"].dependents.some((x) => x.endsWith("App.ts")));
  }],
  ["--find useUserDisplayName returns real .vue path", (d) => {
    const o = runJson(["--find", "useUserDisplayName"], d);
    assert.equal(o.matches[0].file, "src/components/UserCard.vue");
  }],
  ["--find legacyMarker (Options API) returns real .vue path", (d) => {
    const o = runJson(["--find", "legacyMarker"], d);
    assert.ok(o.matches.some((m) => m.file.endsWith("LegacyButton.vue")));
  }],
  ["--relates UserCard.vue names real path + has related", (d) => {
    const o = runJson(["--relates", "UserCard.vue"], d);
    assert.equal(o.file, "src/components/UserCard.vue");
    assert.ok(Array.isArray(o.related) && o.related.length >= 1);
  }],
  ["--map digest includes a .vue file", (d) => {
    const o = runJson(["--map", "--tokens", "8192"], d);
    assert.ok(o.files.some((f) => f.file.endsWith(".vue")));
  }],
  ["--symbols includes a Vue-defined symbol under real path", (d) => {
    const o = runJson(["--symbols", "80"], d);
    assert.ok(o.symbols.some((s) => s.file.endsWith(".vue")));
  }],
  ["SFC→SFC: Composite.vue imports UserCard.vue", (d) => {
    const o = runJson(["--print"], d);
    assert.ok(o.files["src/components/Composite.vue"].imports.some((i) => i.endsWith("UserCard.vue")));
  }],
  ["template-only PureTemplate.vue is omitted", (d) => {
    const o = runJson(["--print"], d);
    assert.ok(!("src/components/PureTemplate.vue" in o.files));
  }],
  ["async setup (top-level await) does not crash", (d) => {
    const o = runJson(["--print"], d);
    assert.ok(o.files["src/components/AsyncProfile.vue"].exports.some((e) => e.name === "asyncMarker"));
  }],
  ["no virtual leak in --find JSON", (d) => {
    const o = runJson(["--find", "Marker"], d);
    assert.equal((JSON.stringify(o).match(VIRTUAL_RE) || []).length, 0);
  }],
  ["no virtual leak in --map JSON", (d) => {
    const o = runJson(["--map"], d);
    assert.equal((JSON.stringify(o).match(VIRTUAL_RE) || []).length, 0);
  }],
  ["no virtual leak in --symbols JSON", (d) => {
    const o = runJson(["--symbols", "50"], d);
    assert.equal((JSON.stringify(o).match(VIRTUAL_RE) || []).length, 0);
  }],
  ["no virtual leak in --hubs JSON", (d) => {
    const o = runJson(["--hubs"], d);
    assert.equal((JSON.stringify(o).match(VIRTUAL_RE) || []).length, 0);
  }],
  ["no virtual leak in --any JSON", (d) => {
    const o = runJson(["--any", "UserCard"], d);
    assert.equal((JSON.stringify(o).match(VIRTUAL_RE) || []).length, 0);
  }],
  ["prose --hubs: UserCard.vue present, no virtual leak", (d) => {
    const out = sh(["--hubs"], d);
    assert.match(out, /UserCard\.vue/);
    assert.ok(!VIRTUAL_RE.test(out), `leak in prose --hubs`);
  }],
];

const dir = mkdtempSync(join(tmpdir(), "vue-sfc-eval-"));
try {
  // Write project files
  for (const [path, content] of Object.entries(PROJECT)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  // Init git + commit so the freshness check has a SHA to compare against.
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=eval@test", "-c", "user.name=eval", "commit", "-q", "-m", "fixture"], { cwd: dir, stdio: "ignore" });

  let passed = 0;
  const failures = [];
  for (const [name, fn] of CHECKS) {
    try { fn(dir); passed++; console.error(`  ✔ ${name}`); }
    catch (e) { failures.push({ name, msg: e.message }); console.error(`  ✖ ${name}\n      ${e.message}`); }
  }
  const pct = ((passed / CHECKS.length) * 100).toFixed(0);
  console.log(`Vue SFC eval: ${passed}/${CHECKS.length} passed (${pct}%)`);
  if (failures.length) process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
