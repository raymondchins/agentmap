// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — Cursor beforeShellExecution gate decision logic.
//
//  Same soft-gate contract as the Codex hook (deny only the narrow structural
//  case, allow everything else), over a DIFFERENT wire format: Cursor puts the
//  shell command at the TOP level of the payload and reads back
//  { permission, user_message, agent_message } rather than Codex's nested
//  hookSpecificOutput. These tests pin both the decisions and that wire format —
//  a decision the agent never receives is the failure mode being guarded.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { makeRepo } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "hooks", "agentmap-cursor-nudge.mjs");

const WITH_AGENTMAP = makeRepo({ "node_modules/@raymondchins/agentmap/package.json": "{}" });
const NO_AGENTMAP = makeRepo({ "README.md": "no agentmap here" });

// Drive the hook with a beforeShellExecution payload. `payload` may override any
// field; `spawnCwd` sets the hook process's own OS-level cwd (used only to prove
// the gate reads payload.cwd rather than process.cwd()).
function gate(command, env = {}, payload = {}, spawnCwd = undefined) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      command,
      cwd: WITH_AGENTMAP,
      hook_event_name: "beforeShellExecution",
      ...payload,
    }),
    cwd: spawnCwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000, // backstop against a wedged hook outliving the test process
  });
  const out = (r.stdout || "").trim();
  let json = null;
  try { json = JSON.parse(out); } catch { /* non-JSON stdout ⇒ json stays null */ }
  return { json, denied: json?.permission === "deny", exit: r.status, out };
}

// --- DENY: high-confidence structural searches ---

test("DENY: bare PascalCase symbol grep (ProviderCard)", () => {
  const g = gate("grep -rn ProviderCard src/");
  assert.equal(g.denied, true, "a bare multi-hump symbol grep must be denied");
  assert.match(g.json.agent_message, /agentmap/, "the deny reason must steer to agentmap");
  assert.match(g.json.agent_message, /AGENTMAP_CURSOR_GATE=0/, "the reason must document the escape hatch");
});

test("DENY: dependency/import search", () => {
  assert.equal(gate('grep -rn "import Foo from" src/').denied, true, "an import/from search must be denied");
});

test("DENY: JSX component tag search", () => {
  assert.equal(gate("rg '<ProviderCard' src/").denied, true, "a PascalCase component tag must be denied");
});

// --- The wire format itself ---

test("DENY carries BOTH the snake_case and camelCase message keys", () => {
  // Cursor's docs specify user_message/agent_message; community type definitions
  // specify userMessage/agentMessage. Emitting one spelling risks a silently
  // swallowed reason — the model would get an unexplained block and retry the
  // same grep. Both are emitted on purpose; this test is what stops a future
  // "cleanup" from deleting the surviving one.
  const g = gate("grep -rn ProviderCard src/");
  for (const k of ["user_message", "agent_message", "userMessage", "agentMessage"]) {
    assert.ok(g.json[k], `deny payload must carry ${k}`);
  }
  assert.equal(g.json.agent_message, g.json.agentMessage, "both agent-message spellings must agree");
  assert.equal(g.json.user_message, g.json.userMessage, "both user-message spellings must agree");
});

test("the user-facing message stays short and does not leak the model instruction block", () => {
  const g = gate("grep -rn ProviderCard src/");
  assert.ok(
    g.json.user_message.length < g.json.agent_message.length,
    "the human message must be the short one",
  );
  assert.doesNotMatch(g.json.user_message, /--relates/, "the human does not need the flag reference");
});

test("the emitted command is never echoed back into the payload (injection safety)", () => {
  const g = gate('grep -rn "ProviderCard\\"; rm -rf /" src/');
  assert.equal(g.denied, true);
  assert.doesNotMatch(g.out, /rm -rf/, "the user's command must never be interpolated into the response");
});

// --- ALLOW: everything else, explicitly ---

test("ALLOW is explicit, not empty stdout", () => {
  // Cursor fails open on unparseable output, so an empty allow would still work
  // — but "no opinion" and "I looked and it is fine" must not be the same bytes.
  const g = gate("cat foo.log | grep TypeError");
  assert.equal(g.denied, false, "a grep after a pipe must not be gated");
  assert.equal(g.json?.permission, "allow", "allow must be stated, not implied");
  assert.equal(g.exit, 0);
});

test("ALLOW: grep against a data/log file", () => {
  assert.equal(gate("grep ProviderCard app.log").denied, false, "a .log operand ⇒ log-filtering, allow");
});

test("ALLOW: non-structural sweep (Tailwind class / lowercase)", () => {
  assert.equal(gate("grep -rn bg-white src/").denied, false, "a Tailwind class is not a structural hunt");
  assert.equal(gate("grep -rn useeffect src/").denied, false, "a lowercase term is not a structural hunt");
});

test("ALLOW: TS generic that looks like a tag", () => {
  assert.equal(gate("grep -rn '<Promise<' src/").denied, false, "a TS generic container must not be denied");
});

test("ALLOW: escape hatch AGENTMAP_CURSOR_GATE=0 overrides a structural grep", () => {
  const g = gate("grep -rn ProviderCard src/", { AGENTMAP_CURSOR_GATE: "0" });
  assert.equal(g.denied, false, "the escape hatch must force allow even on a structural grep");
});

test("ALLOW: a non-shell event never fires", () => {
  // A mis-registered hook (wired into beforeMCPExecution, whose payload has no
  // `command`) must not be able to deny anything.
  const g = gate("grep -rn ProviderCard src/", {}, { hook_event_name: "beforeMCPExecution" });
  assert.equal(g.denied, false, "only beforeShellExecution may gate");
});

test("ALLOW: unparseable stdin falls through rather than blocking", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: "not json at all", encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, "the hook must never exit non-zero on its own parse error");
  assert.notEqual(JSON.parse((r.stdout || "{}").trim()).permission, "deny", "a parse error must not deny");
});

// --- Project-presence gate: MUST come before any deny path ---

test("gate: ALLOW when no agentmap is found anywhere up the tree", () => {
  const g = gate("grep -rn ProviderCard src/", {}, { cwd: NO_AGENTMAP });
  assert.equal(g.denied, false, "a structural grep must not be denied in a repo with no agentmap");
  assert.equal(g.exit, 0);
});

test("gate: DENY still fires when a built map.json alone is present", () => {
  const mapOnlyDir = makeRepo({ ".claude/agentmap/map.json": "{}" });
  const g = gate("grep -rn ProviderCard src/", {}, { cwd: mapOnlyDir });
  assert.equal(g.denied, true, "a built map.json alone must satisfy the gate");
});

test("gate: DENY still fires when the marker is in a PARENT directory (walk-up works)", () => {
  const subdir = join(WITH_AGENTMAP, "packages", "app");
  mkdirSync(subdir, { recursive: true });
  const g = gate("grep -rn ProviderCard src/", {}, { cwd: subdir });
  assert.equal(g.denied, true, "walk-up to a parent marker must still deny");
});

test("gate: falls back to workspace_roots when the payload carries no cwd", () => {
  const g = gate("grep -rn ProviderCard src/", {}, { cwd: undefined, workspace_roots: [WITH_AGENTMAP] });
  assert.equal(g.denied, true, "workspace_roots[0] must be used when cwd is absent");
});

test("gate: payload.cwd wins over the hook process's actual OS cwd", () => {
  const g = gate("grep -rn ProviderCard src/", {}, { cwd: NO_AGENTMAP }, WITH_AGENTMAP);
  assert.equal(g.denied, false, "payload.cwd must override the hook process's own OS cwd");
});
