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
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { makeRepo } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Allow pointing at a scratch copy of the hook during design validation; the
// committed suite resolves the real packaged hook next to agentmap.mjs.
const HOOK = process.env.AGENTMAP_GEMINI_HOOK || join(HERE, "..", "hooks", "agentmap-gemini-nudge.mjs");

// Project-presence gate fixtures. The fire/silent suite below predates the
// gate, so runHook() defaults `payload.cwd` to a fixture WITH agentmap unless
// the caller supplies its own `cwd` — none of the existing cases needed
// touching. The "Project-presence gate" section further down drives
// NO_AGENTMAP and process.cwd()-vs-payload.cwd directly.
const WITH_AGENTMAP = makeRepo({ "node_modules/@raymondchins/agentmap/package.json": "{}" });
const NO_AGENTMAP = makeRepo({ "README.md": "no agentmap here" });

// Low-level runner: feed `payload` as JSON on stdin, optionally spawn the
// subprocess with its OWN OS-level cwd set to `spawnCwd` (used only to prove
// the gate reads payload.cwd, not process.cwd()). Returns { stdout, status }.
function runRaw(payload, spawnCwd) {
  const input = JSON.stringify(payload);
  try {
    const stdout = execFileSync(process.execPath, [HOOK], {
      input,
      cwd: spawnCwd,
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

// Drive the hook: feed `payload` as JSON on stdin, return { stdout, status }.
// Defaults `payload.cwd` to a fixture WITH agentmap so pre-gate tests are
// unaffected; a payload that sets its own `cwd` wins (spread order).
function runHook(payload) {
  return runRaw({ cwd: WITH_AGENTMAP, ...payload });
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

// ─── Project-presence gate ─────────────────────────────────────────────────

test("gate: silent ('{}') when no agentmap found anywhere up the tree", () => {
  const r = runHook({ cwd: NO_AGENTMAP, tool_name: "Grep", tool_input: { pattern: "import { Button }" } });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  assert.equal(r.stdout, "{}", `expected '{}', got: ${r.stdout.slice(0, 200)}`);
});

test("gate: fires when the devDep marker is in cwd directly", () => {
  const r = runHook({ cwd: WITH_AGENTMAP, tool_name: "Grep", tool_input: { pattern: "import { Button }" } });
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.systemMessage, "string", "systemMessage must be a top-level string");
});

test("gate: fires when a built map.json alone is present (no devDep needed)", () => {
  const mapOnlyDir = makeRepo({ ".claude/agentmap/map.json": "{}" });
  const r = runHook({ cwd: mapOnlyDir, tool_name: "Grep", tool_input: { pattern: "import { Button }" } });
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.systemMessage, "string", "a built map.json alone must satisfy the gate");
});

test("gate: fires when the marker is in a PARENT directory (walk-up works)", () => {
  const subdir = join(WITH_AGENTMAP, "packages", "app");
  mkdirSync(subdir, { recursive: true });
  const r = runHook({ cwd: subdir, tool_name: "Grep", tool_input: { pattern: "import { Button }" } });
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.systemMessage, "string", "walk-up to a parent marker must still fire");
});

test("gate: payload.cwd wins over the hook process's actual OS cwd", () => {
  // Spawn the hook with its OS-level cwd pointed at a WITH-agentmap fixture,
  // but tell it (via payload.cwd) the tool call happened in a NO-agentmap
  // fixture. The gate must honor payload.cwd, not process.cwd().
  const r = runRaw(
    { cwd: NO_AGENTMAP, tool_name: "Grep", tool_input: { pattern: "import { Button }" } },
    WITH_AGENTMAP,
  );
  assert.equal(r.stdout, "{}", "payload.cwd must override the hook process's own OS cwd");
});

test("gate: falls back to process.cwd() when payload has no cwd field", () => {
  const r = runRaw({ tool_name: "Grep", tool_input: { pattern: "import { Button }" } }, WITH_AGENTMAP);
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.systemMessage, "string", "must fall back to process.cwd()");
});
