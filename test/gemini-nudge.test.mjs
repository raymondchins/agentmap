// SPDX-License-Identifier: MIT
// Contract #9b — agentmap-gemini-nudge.mjs hook behaviour (Gemini CLI variant).
//
// Regression guard for FIX #4: the Gemini BeforeTool nudge used to emit
// `hookSpecificOutput.additionalContext`, which Gemini CLI supports only on
// AfterTool/BeforeAgent — on BeforeTool it is parsed and silently DROPPED, so
// the nudge never reached the model (a silent no-op). Gemini's BeforeTool
// contract DOES support a top-level `systemMessage`, so the fire path must emit
// that field instead.
//
// This suite drives the hook directly as a subprocess (same as Gemini CLI
// would), covering:
//   - Fire case: emits top-level `systemMessage` (model-visible), does NOT emit
//     `hookSpecificOutput.additionalContext` (the dropped-on-BeforeTool field).
//   - Silent case: stays silent ("{}"), exits 0.
//   - Exit-0 guarantee on both paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
// Allow pointing at a scratch copy of the hook during design validation; the
// committed suite resolves the real packaged hook next to agentmap.mjs.
const HOOK = process.env.AGENTMAP_GEMINI_HOOK || join(HERE, "..", "hooks", "agentmap-gemini-nudge.mjs");

// Drive the hook: feed `payload` as JSON on stdin, return { stdout, status }.
function runHook(payload) {
  const input = JSON.stringify(payload);
  try {
    const stdout = execFileSync(process.execPath, [HOOK], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? "",
      status: typeof e.status === "number" ? e.status : 1,
    };
  }
}

// ─── Fire case — model-visible systemMessage, NOT the dropped field ───────────

test("Gemini fire: emits top-level systemMessage (model-visible)", () => {
  const r = runHook({ tool_name: "Grep", tool_input: { pattern: "import { Button }" } });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  assert.ok(r.stdout.length > 0, "expected output, got silence");
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.systemMessage, "string", "systemMessage must be a top-level string");
  assert.ok(parsed.systemMessage.length > 0, "systemMessage must be non-empty");
  assert.match(parsed.systemMessage, /agentmap/, "systemMessage should mention agentmap");
});

test("Gemini fire: does NOT emit hookSpecificOutput.additionalContext (dropped on BeforeTool)", () => {
  const r = runHook({ tool_name: "Grep", tool_input: { pattern: "import { Button }" } });
  const parsed = JSON.parse(r.stdout);
  assert.equal(
    parsed?.hookSpecificOutput?.additionalContext,
    undefined,
    "additionalContext must NOT be emitted — Gemini drops it on BeforeTool",
  );
});

test("Gemini fire: also fires on Bash searcher via systemMessage", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "rg ProviderCard src/" } });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.systemMessage, "string", "systemMessage must be a top-level string");
  assert.equal(parsed?.hookSpecificOutput?.additionalContext, undefined, "additionalContext must be absent");
});

// ─── Silent case — no regression on raw-string sweeps ──────────────────────

test("Gemini silent: stays silent ('{}') on Tailwind class", () => {
  const r = runHook({ tool_name: "Grep", tool_input: { pattern: "bg-white" } });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  assert.equal(r.stdout, "{}", `expected '{}', got: ${r.stdout.slice(0, 200)}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.systemMessage, undefined, "silent case must not emit systemMessage");
});

test("Gemini silent: stays silent on non-searcher Bash command", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "npm run build" } });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  assert.equal(r.stdout, "{}", `expected '{}', got: ${r.stdout.slice(0, 200)}`);
});

test("Gemini silent: empty payload — no crash, exits 0, no systemMessage", () => {
  const r = runHook({});
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  assert.equal(r.stdout, "{}", `expected '{}', got: ${r.stdout.slice(0, 200)}`);
});
