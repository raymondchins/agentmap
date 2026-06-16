// SPDX-License-Identifier: MIT
// ReDoS regression + edge-case coverage for extractVueScripts().
//
// The pre-fix regex used a nested quantifier over an optional group —
// catastrophic-backtracking shape. A crafted `.vue` file with a malformed
// `<script>` tag (e.g. `<script aaaa…`) could hang agentmap at 100% CPU
// (#15, CWE-1333). This file pins the post-fix contract:
//
//   - Malformed input is rejected in single-digit milliseconds (Group 1, 2).
//   - Pathological 1 MB+ input is rejected by the length guard before any
//     regex work runs (Group 3).
//   - Functional correctness on valid Vue SFC shapes is unchanged (Group 4).
//   - Edge cases unique to the new three-branch non-backtracking regex
//     (`>` inside quoted attrs, quote mixing, malformed-then-valid) are
//     exercised (Group 5).
//
// Tests use a subprocess bootstrap to call `extractVueScripts` directly via
// the `globalThis.__agentmapInternals` test seam (env: AGENTMAP_TEST_EXPORT=1).
// Each timing test runs in a fresh process to isolate V8 JIT state. Functional
// tests (Group 4) reuse the existing CLI fixtures pattern from
// test/vue-sfc/script-extraction.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { AGENTMAP, makeRepo, gitInit, run, cleanup } from "../helpers.mjs";
import { TSCONFIG, LIB_FORMAT, vueJson, leakedVirtualPaths } from "./fixtures.mjs";

// -----------------------------------------------------------------------------
// Direct-invocation harness: spawn agentmap.mjs as a script with the test seam
// enabled, call extractVueScripts(input), return { result, elapsedMs }.
//
// Subprocess isolation is deliberate: V8's regex JIT can warm up and make a
// subsequent call much faster than the first. We want each timing assertion
// to reflect a cold call, not a warm one. Per-test subprocess startup adds
// ~50-100 ms of overhead but keeps timing assertions honest.
// -----------------------------------------------------------------------------
function timeExtractVueScripts(input) {
  const bootstrap = [
    "process.env.AGENTMAP_TEST_EXPORT = '1';",
    "import('" + AGENTMAP + "').then(() => {",
    "  const fn = globalThis.__agentmapInternals && globalThis.__agentmapInternals.extractVueScripts;",
    "  if (typeof fn !== 'function') { console.error('seam not exposed'); process.exit(2); }",
    "  let buf = '';",
    "  process.stdin.on('data', (c) => { buf += c; });",
    "  process.stdin.on('end', () => {",
    "    const { input } = JSON.parse(buf);",
    "    const t0 = process.hrtime.bigint();",
    "    let result;",
    "    try { result = fn(input); }",
    "    catch (e) { result = { __error: e.message }; }",
    "    const t1 = process.hrtime.bigint();",
    "    process.stdout.write(JSON.stringify({ result, elapsedMs: Number(t1 - t0) / 1e6 }));",
    "  });",
    "});",
  ].join(" ");
  const stdout = execFileSync(process.execPath, ["-e", bootstrap], {
    encoding: "utf8",
    input: JSON.stringify({ input }),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
  });
  return JSON.parse(stdout);
}

// Build a one-fixture Vue repo + commit + run --print. Mirrors the pattern
// from script-extraction.test.mjs for Group 4 CLI-based regression tests.
function buildOne(extra) {
  const dir = makeRepo({ ...TSCONFIG, ...LIB_FORMAT, ...extra });
  gitInit(dir, { commit: true });
  const json = vueJson(dir, "--print");
  return { dir, json };
}

// =============================================================================
// Group 1: ReDoS regression — these inputs MUST hang on the pre-fix regex and
// MUST complete in <500 ms on the post-fix regex.
// =============================================================================

test("A: issue POC '<script aaaa…' (40 a's) completes <500 ms and returns null", () => {
  const input = "<script " + "a".repeat(40);
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 500, `elapsedMs=${elapsedMs.toFixed(2)} should be <500`);
  assert.equal(result, null);
});

test("B: unclosed double-quoted attribute '<script lang=\"tsaaa…' completes <500 ms", () => {
  const input = '<script lang="ts' + "a".repeat(200);
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 500, `elapsedMs=${elapsedMs.toFixed(2)} should be <500`);
  assert.equal(result, null);
});

test("C: 200 bareword attrs without '>' completes <500 ms", () => {
  const input = "<script" + " a".repeat(200);
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 500, `elapsedMs=${elapsedMs.toFixed(2)} should be <500`);
  assert.equal(result, null);
});

test("D: 200 name=value attrs without '>' completes <500 ms", () => {
  const input = `<script${' a="b"'.repeat(200)}`;
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 500, `elapsedMs=${elapsedMs.toFixed(2)} should be <500`);
  assert.equal(result, null);
});

test("E: many single-quote chars inside double-quoted value completes <500 ms", () => {
  // Pre-fix regex would catastrophically backtrack on the optional inner group
  // when the quoted value fails to close. Post-fix: "[^"]*" is linear.
  const input = `<script data-x="${"'".repeat(200)}">body</script>`;
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 500, `elapsedMs=${elapsedMs.toFixed(2)} should be <500`);
  // Input IS well-formed; expect body extraction to succeed.
  assert.equal(result && result.text, "body");
});

test("F: mixed whitespace/newlines/tabs before '>' completes <500 ms", () => {
  // Input is well-formed with mixed whitespace; ensure no regression.
  const input = '<script lang="ts"\n\t  setup\n  >body</script>';
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 500, `elapsedMs=${elapsedMs.toFixed(2)} should be <500`);
  assert.equal(result && result.text, "body");
  assert.equal(result && result.setup, true);
  assert.equal(result && result.lang, "ts");
});

// =============================================================================
// Group 2: Timing boundary — stress tests beyond "doesn't hang".
// =============================================================================

test("G: 100k-char unclosed input completes <1000 ms", () => {
  const input = "<script " + "a".repeat(100_000);
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 1000, `elapsedMs=${elapsedMs.toFixed(2)} should be <1000`);
  assert.equal(result, null);
});

test("H: long noise prefix then valid <script> setup completes <1000 ms", () => {
  // 9980 'a' chars form ONE valid bareword identifier (the regex \s+[\w-]+
  // accepts any length). Then '>' closes the open tag. Then </script> closes
  // the (empty) body — the empty-body continue fires, first block skipped.
  // Second <script setup> matches and yields body="body".
  const input = "<script " + "a".repeat(9980) + "><\/script><script setup>body<\/script>";
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 1000, `elapsedMs=${elapsedMs.toFixed(2)} should be <1000`);
  assert.equal(result && result.setup, true);
  assert.equal(result && result.text, "body");
});

// =============================================================================
// Group 3: Length guard — 1 MB+ rejected before regex; just-under still works.
// =============================================================================

test("I: 1 MB+ input rejected by length guard in <50 ms (regex never runs)", () => {
  // Total length: 13 ("<script setup>") + 1_000_000 + 9 ("</script>") = 1_000_022.
  const input = "<script setup>" + "x".repeat(1_000_000) + "<\/script>";
  assert.ok(input.length > 1_000_000, `input.length=${input.length} should be >1_000_000`);
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 50, `elapsedMs=${elapsedMs.toFixed(2)} should be <50`);
  assert.equal(result, null);
});

test("J: just-under-1 MB input still processed (<1000 ms, text extracted)", () => {
  // Total length: 13 + 999_000 + 9 = 999_022. Just under the 1 MB threshold.
  const body = "x".repeat(999_000);
  const input = "<script setup>" + body + "<\/script>";
  assert.ok(input.length <= 1_000_000, `input.length=${input.length} should be <=1_000_000`);
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 1000, `elapsedMs=${elapsedMs.toFixed(2)} should be <1000`);
  assert.equal(result && result.setup, true);
  assert.equal(result && result.text && result.text.length, 999_000);
});

test("length guard rejects non-string input without throwing", () => {
  // The typeof check defends against accidental non-string callers.
  const { result } = timeExtractVueScripts(undefined);
  assert.equal(result, null);
});

// =============================================================================
// Group 4: Functional correctness (quote-aware regression). Mirrors the
// existing tests in script-extraction.test.mjs and script-extraction-generic
// .test.mjs. These are duplicated here so this file is a self-contained
// regression baseline; the sibling files remain unchanged.
// =============================================================================

test("K: typed-generic SFC '<script setup generic=\"T extends …\">' still parses", () => {
  const { dir, json } = buildOne({
    "src/components/TypedTable.vue": [
      `<script setup lang="ts" generic="T extends Record<string, unknown>">`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const n = FORMAT_VERSION;`,
      `export function pickOne(): T { return undefined as T; }`,
      `</script>`,
    ].join("\n"),
  });
  const f = json.files["src/components/TypedTable.vue"];
  assert.ok(f, "TypedTable.vue missing — quote-aware contract regressed");
  assert.ok(f.imports.some((i) => /src\/lib\/format\.ts$/.test(i)));
  assert.ok(f.exports.some((e) => e.name === "pickOne"));
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("L: single-quoted typed-generic SFC '<script generic=\"T, U\">' still parses", () => {
  const { dir, json } = buildOne({
    "src/components/PairView.vue": [
      `<script setup lang='ts' generic='K extends string, V extends number'>`,
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const n = FORMAT_VERSION;`,
      `export function take(k: K, v: V): [K, V] { return [k, v]; }`,
      `</script>`,
    ].join("\n"),
  });
  const f = json.files["src/components/PairView.vue"];
  assert.ok(f, "PairView.vue missing — single-quoted generic attr regressed");
  assert.ok(f.exports.some((e) => e.name === "take"));
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("M: dual <script> block (setup wins over plain)", () => {
  const { dir, json } = buildOne({
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
  });
  const f = json.files["src/components/DualBlock.vue"];
  assert.ok(f, "DualBlock.vue missing");
  assert.ok(f.exports.some((e) => e.name === "dualSetupMarker"));
  assert.ok(!f.exports.some((e) => e.name === "dualNormalMarker"),
    "plain-block marker leaked (setup should win)");
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("N: external <script src=\"…\"> SFC is omitted (target file indexed directly)", () => {
  const { dir, json } = buildOne({
    "src/components/ExternalScript.vue": [
      `<template><div>{{ count }}</div></template>`,
      `<script src="./external-impl.ts"></script>`,
    ].join("\n"),
    "src/components/external-impl.ts": [
      `import { FORMAT_VERSION } from "../lib/format";`,
      `export const externalMarker = "external-impl";`,
      `export const count = FORMAT_VERSION;`,
    ].join("\n"),
  });
  assert.ok(json.files["src/components/external-impl.ts"]);
  assert.ok(!json.files["src/components/ExternalScript.vue"],
    "ExternalScript.vue should be OMITTED (external <script src=…> yields no inline block)");
  assert.equal(leakedVirtualPaths(json).length, 0);
  cleanup(dir);
});

test("O: self-closing '<script/>' yields no block (empty body)", () => {
  const { result } = timeExtractVueScripts("<script/>\n");
  assert.equal(result, null);
});

test("P: template-only file yields no block", () => {
  const { result } = timeExtractVueScripts("<template><div /></template>");
  assert.equal(result, null);
});

test("Q: empty string yields no block", () => {
  const { result } = timeExtractVueScripts("");
  assert.equal(result, null);
});

// =============================================================================
// Group 5: Edge cases unique to the new three-branch non-backtracking regex.
// =============================================================================

test("R: '>' inside double-quoted attr value is preserved", () => {
  const input = `<script generic="Array<{x: number}>">body<\/script>`;
  const { result } = timeExtractVueScripts(input);
  assert.equal(result && result.text, "body");
});

test("S: '>' inside single-quoted attr value is preserved", () => {
  const input = `<script generic='Array<{x: number}>'>body<\/script>`;
  const { result } = timeExtractVueScripts(input);
  assert.equal(result && result.text, "body");
});

test("T: single quote inside double-quoted value is preserved", () => {
  const input = `<script data-x="it's">body<\/script>`;
  const { result } = timeExtractVueScripts(input);
  assert.equal(result && result.text, "body");
});

test("U: double quote inside single-quoted value is preserved", () => {
  const input = `<script data-x='say "hi"'>body<\/script>`;
  const { result } = timeExtractVueScripts(input);
  assert.equal(result && result.text, "body");
});

test("V: bare '<script>' (no attrs) still matches", () => {
  const input = "<script>body<\/script>";
  const { result } = timeExtractVueScripts(input);
  assert.equal(result && result.text, "body");
  assert.equal(result && result.setup, false);
  assert.equal(result && result.lang, "js");
});

test("W: malformed first <script> + valid second <script> — valid block is matched", () => {
  // Pre-fix naive non-backtracking form (/<script\b(?:[^>"']|"…"|'…')*>/) would
  // WRONGLY match `<` as an attr char and swallow both tags as one. The
  // correct three-branch form requires \s+ before each attr, so the malformed
  // first tag fails to match and the second valid tag is found.
  const input = "<script aaaa<script setup>body<\/script>";
  const { result } = timeExtractVueScripts(input);
  assert.equal(result && result.setup, true);
  assert.equal(result && result.text, "body");
});

test("X: 50 valid name=value attrs + body parses <500 ms", () => {
  const input = `<script${' a="b"'.repeat(50)}>body<\/script>`;
  const { result, elapsedMs } = timeExtractVueScripts(input);
  assert.ok(elapsedMs < 500, `elapsedMs=${elapsedMs.toFixed(2)} should be <500`);
  assert.equal(result && result.text, "body");
});

// =============================================================================
// End-to-end CLI smoke: malicious .vue file in a real repo must NOT hang.
// This is the user-visible ReDoS contract — a crafted .vue file placed in a
// scanned repo does not prevent agentmap from completing its work.
// =============================================================================

test("end-to-end: --map on a repo with a ReDoS .vue file completes in <10 s", () => {
  const dir = makeRepo({
    ...TSCONFIG,
    "src/Bad.vue": "<script " + "a".repeat(10_000) + "\n", // unclosed, would hang pre-fix
    "src/lib/format.ts": "export const FORMAT_VERSION = 1;\n",
  });
  gitInit(dir, { commit: true });
  const start = Date.now();
  const r = run(dir, "--map");
  const elapsed = Date.now() - start;
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(elapsed < 10_000, `--map took ${elapsed}ms; should be <10 s`);
  // Bad.vue is silently skipped (extractVueScripts returns null), but --map
  // still succeeds and other files are indexed.
  cleanup(dir);
});

test("end-to-end: --map on a repo with a 2 MB .vue file completes in <10 s", () => {
  const dir = makeRepo({
    ...TSCONFIG,
    "src/Huge.vue": "<script setup>" + "x".repeat(2_000_000) + "<\/script>",
    "src/lib/format.ts": "export const FORMAT_VERSION = 1;\n",
  });
  gitInit(dir, { commit: true });
  const start = Date.now();
  const r = run(dir, "--map");
  const elapsed = Date.now() - start;
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(elapsed < 10_000, `--map took ${elapsed}ms; should be <10 s`);
  // Huge.vue is rejected by the length guard; not in the map.
  cleanup(dir);
});
