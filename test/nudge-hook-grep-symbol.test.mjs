// SPDX-License-Identifier: MIT
// Regression: agentmap-nudge.mjs — Grep-branch bare-PascalCase symbol catch +
// npx-first command in the emitted message.
//
// Two fixes are locked in here:
//   #3 (grep-symbol gap): SYMBOL_RE (bare multi-hump PascalCase) was applied
//      only in the Bash branch, so `{Grep, "ProviderCard"}` — the single most
//      common structural search — never fired. It now does, while staying
//      silent on Tailwind classes, lowercase HTML tags, single-hump/all-caps,
//      and lowercase-first identifiers (useState).
//   #2 (install path): the emitted command must be `npx @raymondchins/agentmap`
//      (works for npx/global installs), NOT the old
//      `node node_modules/@raymondchins/...` (ENOENTs unless locally installed).
//
// The hook is a standalone stdin→stdout JSON filter: feed it a
// {tool_name, tool_input} payload on stdin, read the JSON it writes on stdout
// (or empty string when it stays silent). It always exits 0. We drive it as a
// subprocess exactly as Claude Code would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "hooks", "agentmap-nudge.mjs");

// Drive the hook: feed `payload` as JSON on stdin, return { stdout, status }.
// spawnSync never throws on a non-zero exit, so we can assert the exit code too.
function runHook(payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: typeof r.status === "number" ? r.status : 1 };
}

// Assert the hook fired (emitted a non-empty additionalContext), exit 0.
function assertFires(result, label) {
  assert.equal(result.status, 0, `${label}: expected exit 0, got ${result.status}`);
  assert.ok(result.stdout.length > 0, `${label}: expected output, got silence`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(
    parsed?.hookSpecificOutput?.additionalContext?.length > 0,
    `${label}: hookSpecificOutput.additionalContext missing or empty`,
  );
}

// Assert the hook stayed silent (no stdout), exit 0.
function assertSilent(result, label) {
  assert.equal(result.status, 0, `${label}: expected exit 0, got ${result.status}`);
  assert.equal(result.stdout, "", `${label}: expected silence, got: ${result.stdout.slice(0, 200)}`);
}

// ─── #3: Grep-branch bare-PascalCase symbol hunt now FIRES ────────────────────

test("Grep: FIRES on bare PascalCase symbol (ProviderCard)", () => {
  // The headline gap this fix closes: a bare multi-hump identifier with no `<`
  // prefix — the most common structural search on Claude Code.
  assertFires(
    runHook({ tool_name: "Grep", tool_input: { pattern: "ProviderCard" } }),
    "Grep bare ProviderCard",
  );
});

test("Grep: FIRES on bare PascalCase symbol (TopProviders)", () => {
  assertFires(
    runHook({ tool_name: "Grep", tool_input: { pattern: "TopProviders" } }),
    "Grep bare TopProviders",
  );
});

// ─── #3: high-signal guarantees must hold — these stay SILENT ─────────────────

test("Grep: stays silent on Tailwind class (bg-white)", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "bg-white" } }),
    "Grep bg-white",
  );
});

test("Grep: stays silent on Tailwind class (text-3xl)", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "text-3xl" } }),
    "Grep text-3xl",
  );
});

test("Grep: stays silent on lowercase-first identifier (useState)", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "useState" } }),
    "Grep useState",
  );
});

test("Grep: stays silent on lowercase HTML tag (<div)", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "<div" } }),
    "Grep <div",
  );
});

test("Grep: stays silent on single-hump PascalCase (Button)", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "Button" } }),
    "Grep Button",
  );
});

test("Grep: stays silent on all-caps word (TODO)", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "TODO" } }),
    "Grep TODO",
  );
});

// ─── #2: emitted command is npx-first, never the old node_modules path ────────

test("fired message: contains 'npx @raymondchins/agentmap', not 'node node_modules/@raymondchins'", () => {
  const r = runHook({ tool_name: "Grep", tool_input: { pattern: "ProviderCard" } });
  assert.equal(r.status, 0);
  const msg = JSON.parse(r.stdout)?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(msg, /npx @raymondchins\/agentmap/, "message should recommend `npx @raymondchins/agentmap`");
  assert.doesNotMatch(
    msg,
    /node node_modules\/@raymondchins/,
    "message must NOT hardcode the local `node node_modules/@raymondchins` path (ENOENTs on npx/global installs)",
  );
});
