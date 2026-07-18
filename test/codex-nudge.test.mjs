// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — Codex CLI PreToolUse gate decision logic.
//
//  Codex only honors permissionDecision "deny"/"allow" on PreToolUse (an "ask"
//  or additionalContext fails open), so this hook DENYs only the narrow,
//  high-confidence structural-search case and stays SILENT (= allow) otherwise.
//  These lock the gate boundary: a bare-symbol / dependency / component grep is
//  denied with a reason; log-filtering, piped greps, non-structural sweeps, and
//  the AGENTMAP_CODEX_GATE=0 escape hatch all fall through to allow.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { makeRepo } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "hooks", "agentmap-codex-nudge.mjs");

// Project-presence gate fixtures. The DENY/ALLOW suite below predates the
// gate, so gate() defaults `payload.cwd` to a fixture WITH agentmap unless
// the caller passes its own `cwd` — none of those existing cases needed
// touching. The "Project-presence gate" section further down drives
// NO_AGENTMAP and process.cwd()-vs-payload.cwd directly.
const WITH_AGENTMAP = makeRepo({ "node_modules/@raymondchins/agentmap/package.json": "{}" });
const NO_AGENTMAP = makeRepo({ "README.md": "no agentmap here" });

// Drive the hook: pipe a Bash tool-call payload, return { denied, reason, exit }.
// `payload` may override `cwd`; `spawnCwd` sets the hook process's own OS-level
// cwd (used only to prove the gate reads payload.cwd, not process.cwd()).
function gate(command, env = {}, payload = {}, spawnCwd = undefined) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      cwd: WITH_AGENTMAP,
      tool_name: "Bash",
      tool_input: { command },
      ...payload,
    }),
    cwd: spawnCwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const out = (r.stdout || "").trim();
  let denied = false, reason = "";
  if (out) {
    try {
      const j = JSON.parse(out);
      denied = j?.hookSpecificOutput?.permissionDecision === "deny";
      reason = j?.hookSpecificOutput?.permissionDecisionReason || "";
    } catch { /* non-JSON stdout ⇒ treat as not-denied */ }
  }
  return { denied, reason, exit: r.status, out };
}

// --- DENY: high-confidence structural searches ---

test("DENY: bare PascalCase symbol grep (ProviderCard)", () => {
  const g = gate("grep -rn ProviderCard src/");
  assert.equal(g.denied, true, "a bare multi-hump symbol grep must be denied");
  assert.match(g.reason, /agentmap/, "the deny reason must steer to agentmap");
  assert.match(g.reason, /AGENTMAP_CODEX_GATE=0/, "the reason must document the escape hatch");
});

test("DENY: dependency/import search", () => {
  assert.equal(gate("grep -rn \"import Foo from\" src/").denied, true, "an import/from search must be denied");
});

test("DENY: JSX component tag search", () => {
  assert.equal(gate("rg '<ProviderCard' src/").denied, true, "a PascalCase component tag must be denied");
});

// --- ALLOW (silent, exit 0): everything else ---

test("ALLOW: piped log-filter is not the primary command", () => {
  const g = gate("cat foo.log | grep TypeError");
  assert.equal(g.denied, false, "a grep after a pipe must not be gated");
  assert.equal(g.out, "", "allow = empty stdout");
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

test("ALLOW: escape hatch AGENTMAP_CODEX_GATE=0 overrides a structural grep", () => {
  const g = gate("grep -rn ProviderCard src/", { AGENTMAP_CODEX_GATE: "0" });
  assert.equal(g.denied, false, "the escape hatch must force allow even on a structural grep");
});

test("ALLOW: a non-Bash tool never fires", () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "ProviderCard.tsx" } }),
    encoding: "utf8",
  });
  assert.equal((r.stdout || "").trim(), "", "a non-Bash tool must be allowed silently");
});

// --- Project-presence gate: MUST come before any deny path ---

test("gate: ALLOW (not denied) when no agentmap found anywhere up the tree", () => {
  const g = gate("grep -rn ProviderCard src/", {}, { cwd: NO_AGENTMAP });
  assert.equal(g.denied, false, "a structural grep must not be denied in a repo with no agentmap");
  assert.equal(g.out, "", "allow = empty stdout");
  assert.equal(g.exit, 0);
});

test("gate: DENY still fires when the devDep marker is in cwd directly", () => {
  const g = gate("grep -rn ProviderCard src/", {}, { cwd: WITH_AGENTMAP });
  assert.equal(g.denied, true, "the gate must not suppress a real agentmap project");
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

test("gate: payload.cwd wins over the hook process's actual OS cwd", () => {
  // Spawn the hook with its OS-level cwd pointed at a WITH-agentmap fixture,
  // but tell it (via payload.cwd) the tool call happened in a NO-agentmap
  // fixture. The gate must honor payload.cwd, not process.cwd().
  const g = gate("grep -rn ProviderCard src/", {}, { cwd: NO_AGENTMAP }, WITH_AGENTMAP);
  assert.equal(g.denied, false, "payload.cwd must override the hook process's own OS cwd");
});
