// SPDX-License-Identifier: MIT
// Shared Vue SFC fixtures for the agentmap Vue test suite.
//
// Centralized fixtures + helpers so each test file stays small and focused.
// Importing these gives every test a consistent, real-world Vue project shape:
//   - a tsconfig that includes .vue + .ts
//   - a `lib/` of plain TS helpers (exporters)
//   - a `components/` of Vue SFCs exercising different script-block idioms
//   - an `App.ts` / `App.vue` that wire components together
//
// Every fixture is a plain object of { path: contents }, ready to pass to
// `makeRepo()` or `writeFiles()` from test/helpers.mjs.

// ---------------------------------------------------------------------------
// Plain TS helper library — the import TARGET most SFCs reach for.
// ---------------------------------------------------------------------------
export const LIB_FORMAT = {
  "src/lib/format.ts": [
    `export function formatUserName(n: string) { return n.trim(); }`,
    `export const FORMAT_VERSION = 1;`,
    `export interface User { id: number; name: string; }`,
    `export type UserKind = "admin" | "guest";`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// A canonical Vue 3 SFC using `<script setup lang="ts">` — the modern idiom.
// Exports a const + a function + relies on `defineProps`/`defineEmits` macros
// (which are Vue compiler macros, NOT imports — they must not break the parser).
// ---------------------------------------------------------------------------
export const SFC_SETUP_TS = {
  "src/components/UserCard.vue": [
    `<template>`,
    `  <article :class="$props.kind">`,
    `    <header>{{ displayName }}</header>`,
    `    <slot />`,
    `  </article>`,
    `</template>`,
    ``,
    `<script setup lang="ts">`,
    `import { computed } from "vue";`,
    `import { formatUserName } from "../lib/format";`,
    `import type { User } from "../lib/format";`,
    ``,
    `const props = defineProps<{ user: User; kind: string }>();`,
    `defineEmits<{ (e: "select", id: number): void }>();`,
    ``,
    `export const userCardMarker = "vue-sfc";`,
    ``,
    `export function useUserDisplayName(): string {`,
    `  return computed(() => formatUserName(props.user.name)).value;`,
    `}`,
    `</script>`,
    ``,
    `<style scoped>`,
    `article { color: red; }`,
    `</style>`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Plain `<script>` (no `setup`, no `lang`) — legacy / Options-API style.
// Exports a default object component + a named marker so we can assert both
// default and named exports are detected from the SAME SFC.
// ---------------------------------------------------------------------------
export const SFC_OPTIONS_JS = {
  "src/components/LegacyButton.vue": [
    `<template><button @click="onClick"><slot /></button></template>`,
    `<script>`,
    `import { FORMAT_VERSION } from "../lib/format";`,
    ``,
    `export const legacyMarker = "options-api";`,
    ``,
    `export default {`,
    `  name: "LegacyButton",`,
    `  data() { return { version: FORMAT_VERSION }; },`,
    `  methods: { onClick() { this.$emit("click"); } },`,
    `};`,
    `</script>`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// `<script lang="ts">` WITHOUT `setup` — TS Options API. Ensures `lang="ts"`
// detection works independently of the `setup` attribute.
// ---------------------------------------------------------------------------
export const SFC_OPTIONS_TS = {
  "src/components/TypedCounter.vue": [
    `<template><div>{{ count }}</div></template>`,
    `<script lang="ts">`,
    `import { FORMAT_VERSION } from "../lib/format";`,
    `import type { UserKind } from "../lib/format";`,
    ``,
    `export const typedCounterMarker = "options-ts";`,
    `export const initialCount: number = FORMAT_VERSION;`,
    `export function kindLabel(k: UserKind): string { return k.toUpperCase(); }`,
    ``,
    `export default { data() { return { count: initialCount }; } };`,
    `</script>`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// SFC with BOTH `<script setup lang="ts">` AND a normal `<script>` block
// (Vue 3 supports this for cases where you need `export default` for options
// the `setup` block can't express, e.g. component name + inheritance attrs).
// extractVueScripts should prefer the `setup` block.
// ---------------------------------------------------------------------------
export const SFC_DUAL_SCRIPT = {
  "src/components/DualBlock.vue": [
    `<template><div>{{ msg }}</div></template>`,
    `<script>`,
    `export const dualNormalMarker = "dual-normal";`,
    `export default { name: "DualBlock", inheritAttrs: false };`,
    `</script>`,
    `<script setup lang="ts">`,
    `import { FORMAT_VERSION } from "../lib/format";`,
    `export const dualSetupMarker = "dual-setup";`,
    `export const msg = \`v\${FORMAT_VERSION}\`;`,
    `</script>`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// External script reference (`<script src="...">`) — extractVueScripts MUST
// skip this entirely. The referenced file is already a regular `.ts`/`.js` on
// disk and will be indexed on its own; double-indexing would corrupt the graph.
// ---------------------------------------------------------------------------
export const SFC_EXTERNAL_SCRIPT = {
  "src/components/ExternalScript.vue": [
    `<template><div>{{ count }}</div></template>`,
    `<script src="./external-impl.ts"></script>`,
  ].join("\n"),
  "src/components/external-impl.ts": [
    `import { FORMAT_VERSION } from "../lib/format";`,
    `export const externalMarker = "external-impl";`,
    `export const count = FORMAT_VERSION;`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Template-only SFC — no `<script>` block at all. Must be OMITTED from the
// map entirely (no entry, no exports, no imports). Common for presentational
// wrappers.
// ---------------------------------------------------------------------------
export const SFC_TEMPLATE_ONLY = {
  "src/components/PureTemplate.vue": [
    `<template>`,
    `  <p class="banner">Static content only.</p>`,
    `</template>`,
    `<style scoped>.banner { color: blue; }</style>`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// `<script setup>` with top-level `await` (async setup, Suspense-only). TS
// parser must accept this; should not crash ts-morph.
// ---------------------------------------------------------------------------
export const SFC_SETUP_AWAIT = {
  "src/components/AsyncProfile.vue": [
    `<template><div>{{ data }}</div></template>`,
    `<script setup lang="ts">`,
    `import { FORMAT_VERSION } from "../lib/format";`,
    ``,
    `export const asyncMarker = "await";`,
    `const data = await Promise.resolve(FORMAT_VERSION);`,
    `</script>`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Single-quoted attribute variants: `<script lang='ts' setup>` and reverse
// order `<script setup lang='ts'>`. Both must be parsed by the regex.
// ---------------------------------------------------------------------------
export const SFC_SINGLE_QUOTE_ATTRS = {
  "src/components/SingleQuote.vue": [
    `<template><div>{{ n }}</div></template>`,
    `<script lang='ts' setup>`,
    `import { FORMAT_VERSION } from "../lib/format";`,
    `export const singleQuoteMarker = "sq";`,
    `export const n = FORMAT_VERSION;`,
    `</script>`,
  ].join("\n"),
  "src/components/ReversedAttrs.vue": [
    `<template><div>{{ m }}</div></template>`,
    `<script setup lang='ts'>`,
    `import { FORMAT_VERSION } from "../lib/format";`,
    `export const reversedAttrsMarker = "ra";`,
    `export const m = FORMAT_VERSION;`,
    `</script>`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// A second plain TS lib so SFC→SFC chains have somewhere to point that's NOT
// just `lib/format.ts` (lets us assert cross-component edges distinctly).
// ---------------------------------------------------------------------------
export const LIB_VALIDATION = {
  "src/lib/validate.ts": [
    `export function isEmail(s: string): boolean { return s.includes("@"); }`,
    `export const EMAIL_REGEX = /[^@]+@[^@]+/;`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// SFC #2 that imports a different helper than UserCard — used to assert that
// edges from different SFCs land on the correct targets.
// ---------------------------------------------------------------------------
export const SFC_VALIDATOR = {
  "src/components/EmailField.vue": [
    `<template><input :value="value" /></template>`,
    `<script setup lang="ts">`,
    `import { isEmail, EMAIL_REGEX } from "../lib/validate";`,
    `export const emailFieldMarker = "email";`,
    `export function valid(s: string) { return isEmail(s) && EMAIL_REGEX.test(s); }`,
    `</script>`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// `.vue` importing another `.vue` (cross-SFC edge). Drills the resolver path
// that already worked for App.ts → UserCard.vue, but now the IMPORTER side is
// also virtual.
// ---------------------------------------------------------------------------
export const SFC_IMPORTS_SFC = {
  "src/components/Composite.vue": [
    `<template><UserCard /></template>`,
    `<script setup lang="ts">`,
    `import UserCard from "./UserCard.vue";`,
    `export const compositeMarker = "composite";`,
    `export const inner = UserCard;`,
    `</script>`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// tsconfig that includes everything we need. Shared across most fixtures.
// ---------------------------------------------------------------------------
export const TSCONFIG = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { allowJs: true, checkJs: false },
    include: ["**/*.ts", "**/*.vue", "src/**/*"],
  }),
};

// ---------------------------------------------------------------------------
// Full Vue project: combines the canonical pieces into one realistic repo.
// Used by tests that need a realistic multi-file graph.
// ---------------------------------------------------------------------------
export const VUE_PROJECT = {
  ...TSCONFIG,
  ...LIB_FORMAT,
  ...LIB_VALIDATION,
  ...SFC_SETUP_TS,       // UserCard.vue  → lib/format.ts
  ...SFC_OPTIONS_JS,     // LegacyButton.vue → lib/format.ts
  ...SFC_OPTIONS_TS,     // TypedCounter.vue → lib/format.ts
  ...SFC_DUAL_SCRIPT,    // DualBlock.vue → lib/format.ts (setup wins)
  ...SFC_EXTERNAL_SCRIPT,// ExternalScript.vue (skipped) + external-impl.ts
  ...SFC_TEMPLATE_ONLY,  // PureTemplate.vue (omitted from map)
  ...SFC_SETUP_AWAIT,    // AsyncProfile.vue → lib/format.ts
  ...SFC_SINGLE_QUOTE_ATTRS, // SingleQuote + ReversedAttrs
  ...SFC_VALIDATOR,      // EmailField.vue → lib/validate.ts
  ...SFC_IMPORTS_SFC,    // Composite.vue → UserCard.vue
  "src/App.ts": [
    `import UserCard from "./components/UserCard.vue";`,
    `import LegacyButton from "./components/LegacyButton.vue";`,
    `export const appUsesUserCard = UserCard;`,
    `export const appUsesLegacy = LegacyButton;`,
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Helpers — run the CLI, parse the single-JSON-object stdout, and apply the
// canonical Vue path assertion (no virtual paths anywhere in the output).
// ---------------------------------------------------------------------------

// Run `agentmap` in `dir` with given args; assert exit 0; parse stdout as JSON.
export function vueJson(dir, ...args) {
  const { run } = helpers();
  const r = run(dir, "--json", ...args);
  if (r.status !== 0) {
    const err = new Error(`agentmap --json ${args.join(" ")} exited ${r.status}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
    err.result = r;
    throw err;
  }
  try { return JSON.parse(r.stdout); }
  catch { throw new Error(`stdout was not a single JSON object:\n${r.stdout}`); }
}

// Sync require of test/helpers.mjs so fixtures stay pure data. Resolved against
// this module's URL so it works regardless of the test runner's cwd.
import { createRequire } from "node:module";
const helpers = () => createRequire(import.meta.url)("../helpers.mjs");

// Any leaked virtual path (Foo.vue.ts / Foo.vue.js) is a contract violation.
const VIRTUAL_RE = /\.vue\.(ts|js|mjs|cjs|tsx|jsx)$/i;

// Walks an arbitrary JSON value and returns every leaked virtual path found.
// Recurses into objects and arrays so nested command outputs (e.g. --relates
// `related[]`, --map `files[].symbols[]`) are all covered.
export function leakedVirtualPaths(value, acc = []) {
  if (typeof value === "string") {
    if (VIRTUAL_RE.test(value)) acc.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) leakedVirtualPaths(v, acc);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) leakedVirtualPaths(v, acc);
  }
  return acc;
}
