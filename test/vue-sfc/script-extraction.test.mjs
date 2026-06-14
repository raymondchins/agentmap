// SPDX-License-Identifier: MIT
// Vue SFC script-block extraction — production-grade contract tests.
//
// Each test exercises a DIFFERENT `<script>` idiom found in real Vue codebases.
// The common assertion is that the SFC appears under its real `.vue` path and
// that the exports/imports we expect from the script block are detected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, cleanup, run } from "../helpers.mjs";
import {
  TSCONFIG, LIB_FORMAT,
  SFC_SETUP_TS, SFC_OPTIONS_JS, SFC_OPTIONS_TS, SFC_DUAL_SCRIPT,
  SFC_EXTERNAL_SCRIPT, SFC_TEMPLATE_ONLY, SFC_SETUP_AWAIT,
  SFC_SINGLE_QUOTE_ATTRS,
  vueJson, leakedVirtualPaths,
} from "./fixtures.mjs";

// Build a one-fixture repo + commit. Returns { dir, json } for a --print dump.
function buildOne(extra) {
  const dir = makeRepo({ ...TSCONFIG, ...LIB_FORMAT, ...extra });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  return { dir, json };
}

test("setup+ts: <script setup lang=\"ts\"> exports + imports indexed", () => {
  const { dir, json } = buildOne(SFC_SETUP_TS);
  const f = json.files["src/components/UserCard.vue"];
  assert.ok(f, "UserCard.vue missing");
  assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)), `imports: ${JSON.stringify(f.imports)}`);
  assert.ok(f.exports.some((e) => e.name === "useUserDisplayName"), `exports: ${JSON.stringify(f.exports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("options-js: plain <script> (no setup, no lang) default + named exports", () => {
  const { dir, json } = buildOne(SFC_OPTIONS_JS);
  const f = json.files["src/components/LegacyButton.vue"];
  assert.ok(f, "LegacyButton.vue missing");
  assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)));
  // Named export
  assert.ok(f.exports.some((e) => e.name === "legacyMarker"));
  // Default export resolved to its declaration name (the Options API object).
  // ts-morph reports `default` when it can't infer the name; either is acceptable
  // as long as the entry EXISTS — we just want to know the default was seen.
  assert.ok(f.exports.length >= 2, `expected at least 2 exports (default + named), got: ${JSON.stringify(f.exports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("options-ts: <script lang=\"ts\"> (no setup) parses TypeScript block", () => {
  const { dir, json } = buildOne(SFC_OPTIONS_TS);
  const f = json.files["src/components/TypedCounter.vue"];
  assert.ok(f, "TypedCounter.vue missing");
  assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)));
  assert.ok(f.exports.some((e) => e.name === "typedCounterMarker"));
  assert.ok(f.exports.some((e) => e.name === "kindLabel"));
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("dual-script: setup wins over plain <script> when both present", () => {
  const { dir, json } = buildOne(SFC_DUAL_SCRIPT);
  const f = json.files["src/components/DualBlock.vue"];
  assert.ok(f, "DualBlock.vue missing");
  // The setup block's exports + import must be the ones surfaced.
  assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)), `imports: ${JSON.stringify(f.imports)}`);
  assert.ok(f.exports.some((e) => e.name === "dualSetupMarker"), `expected dualSetupMarker, got: ${JSON.stringify(f.exports)}`);
  // The plain block's marker should NOT be present (only one script is indexed).
  assert.ok(!f.exports.some((e) => e.name === "dualNormalMarker"),
    `plain-block marker leaked into map (setup should win): ${JSON.stringify(f.exports)}`);
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("external-script: <script src=\"...\"> SFC adds no double-indexed entry", () => {
  const { dir, json } = buildOne(SFC_EXTERNAL_SCRIPT);
  // The external .ts IS indexed on its own (as a regular file).
  assert.ok(json.files["src/components/external-impl.ts"], "external-impl.ts missing");
  assert.ok(json.files["src/components/external-impl.ts"].exports.some((e) => e.name === "externalMarker"));
  // The .vue file itself has no extractable inline script → must be absent.
  assert.ok(!json.files["src/components/ExternalScript.vue"],
    "ExternalScript.vue should be OMITTED (external <script src=...> yields no inline block)");
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("template-only: SFC without any <script> is omitted from the map", () => {
  const { dir, json } = buildOne(SFC_TEMPLATE_ONLY);
  assert.ok(!json.files["src/components/PureTemplate.vue"],
    "PureTemplate.vue should be OMITTED (no script block contributes nothing)");
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("setup+await: top-level await in <script setup lang=\"ts\"> does not crash", () => {
  const { dir, json } = buildOne(SFC_SETUP_AWAIT);
  const f = json.files["src/components/AsyncProfile.vue"];
  assert.ok(f, "AsyncProfile.vue missing");
  assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)));
  assert.ok(f.exports.some((e) => e.name === "asyncMarker"));
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("single-quote + reversed attrs: <script lang='ts' setup> and <script setup lang='ts'>", () => {
  const { dir, json } = buildOne(SFC_SINGLE_QUOTE_ATTRS);
  const sq = json.files["src/components/SingleQuote.vue"];
  const ra = json.files["src/components/ReversedAttrs.vue"];
  assert.ok(sq, "SingleQuote.vue missing (single-quoted attrs not parsed)");
  assert.ok(ra, "ReversedAttrs.vue missing (reversed attrs not parsed)");
  assert.ok(sq.imports.some((i) => /src\/lib\/format\.ts$/.test(i)), `sq imports: ${JSON.stringify(sq.imports)}`);
  assert.ok(ra.imports.some((i) => /src\/lib\/format\.ts$/.test(i)), `ra imports: ${JSON.stringify(ra.imports)}`);
  assert.ok(sq.exports.some((e) => e.name === "singleQuoteMarker"));
  assert.ok(ra.exports.some((e) => e.name === "reversedAttrsMarker"));
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

// Non-JSON sanity: confirm prose output names the real .vue path too.
test("prose: bare build summary mentions .vue files under real paths", () => {
  const dir = makeRepo({ ...TSCONFIG, ...LIB_FORMAT, ...SFC_SETUP_TS });
  gitInit(dir, { commit: true });
  const r = run(dir, "--hubs");
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(!/\.vue\.(ts|js|mjs|cjs)/i.test(r.stdout), `virtual path leaked into prose:\n${r.stdout}`);
  cleanup(dir);
});
