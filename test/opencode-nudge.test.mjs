// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — OpenCode plugin project-presence gate.
//
//  skills/opencode-agentmap-nudge.js ships in every OpenCode project via
//  `--install-skill --platform opencode` (and can be installed globally under
//  ~/.config/opencode/plugins/), so without a gate it logs a nudge in every
//  repo the plugin loads into — including ones with no agentmap at all.
//
//  Unlike the Claude/Codex/Gemini hooks (standalone subprocesses reading JSON
//  on stdin), this is an in-process OpenCode plugin: `AgentmapNudge({ client,
//  directory })` returns a hooks object, and OpenCode calls
//  `hooks["tool.execute.before"](input, output)` before every tool call.
//  OpenCode gives us `directory` (the project cwd) once at plugin-load time,
//  not per call, so the gate is computed once and cached for the plugin's
//  lifetime — these tests drive the factory directly (no subprocess).
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentmapNudge } from "../skills/opencode-agentmap-nudge.js";
import { makeRepo } from "./helpers.mjs";

const WITH_AGENTMAP = makeRepo({ "node_modules/@raymondchins/agentmap/package.json": "{}" });
const NO_AGENTMAP = makeRepo({ "README.md": "no agentmap here" });

// Fake OpenCode client — captures every log() call so tests can assert on it.
function fakeClient() {
  const calls = [];
  return {
    calls,
    client: { app: { log: async (args) => { calls.push(args); } } },
  };
}

async function fireStructuralBash(directory) {
  const { client, calls } = fakeClient();
  const plugin = await AgentmapNudge({ client, directory });
  await plugin["tool.execute.before"](
    { tool: "bash" },
    { args: { command: "rg ProviderCard src/" } },
  );
  return calls;
}

// ─── Baseline behavior (agentmap present) ──────────────────────────────────

test("logs on a structural bash search when agentmap is present", async () => {
  const calls = await fireStructuralBash(WITH_AGENTMAP);
  assert.equal(calls.length, 1, "expected exactly one log call");
  assert.match(calls[0].body.message, /agentmap/i);
});

test("non-structural command never logs, even with agentmap present", async () => {
  const { client, calls } = fakeClient();
  const plugin = await AgentmapNudge({ client, directory: WITH_AGENTMAP });
  await plugin["tool.execute.before"](
    { tool: "bash" },
    { args: { command: "npm run build" } },
  );
  assert.equal(calls.length, 0);
});

// ─── Project-presence gate ─────────────────────────────────────────────────

test("gate: stays silent when no agentmap found anywhere up the tree", async () => {
  const calls = await fireStructuralBash(NO_AGENTMAP);
  assert.equal(calls.length, 0, "must not log when the project has no agentmap");
});

test("gate: fires when the devDep marker is in `directory` directly", async () => {
  const calls = await fireStructuralBash(WITH_AGENTMAP);
  assert.equal(calls.length, 1);
});

test("gate: fires when a built map.json alone is present (no devDep needed)", async () => {
  const mapOnlyDir = makeRepo({ ".claude/agentmap/map.json": "{}" });
  const calls = await fireStructuralBash(mapOnlyDir);
  assert.equal(calls.length, 1, "a built map.json alone must satisfy the gate");
});

test("gate: still fires when the marker is in a PARENT of `directory` (walk-up works)", async () => {
  const subdir = join(WITH_AGENTMAP, "packages", "app");
  mkdirSync(subdir, { recursive: true });
  const calls = await fireStructuralBash(subdir);
  assert.equal(calls.length, 1, "walk-up to a parent marker must still fire");
});

test("gate: falls back to process.cwd() when `directory` is not provided", async () => {
  // Sanity check only — process.cwd() during `npm test` is wherever the test
  // runner was invoked from, whose real agentmap state this suite should not
  // assert on. Just confirm the plugin never throws when `directory` is absent.
  const { client } = fakeClient();
  const plugin = await AgentmapNudge({ client });
  await assert.doesNotReject(
    plugin["tool.execute.before"]({ tool: "bash" }, { args: { command: "rg ProviderCard src/" } }),
  );
});
