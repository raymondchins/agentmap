// SPDX-License-Identifier: MIT
// OpenCode plugin — logs a reminder when bash/grep looks like a structural search.
// Always-on guidance lives in AGENTS.md (installed by --install-skill).
// Non-blocking: uses client.app.log when available.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Project-presence gate — see hooks/agentmap-nudge.mjs for the full
// rationale (this plugin ships globally too via `~/.config/opencode/plugins/`,
// so without it it logs in every repo, agentmap or not). Standalone copy —
// these files are distributed separately, no shared import. Never throws.
const MAX_WALK_UP = 12;
function hasAgentmapProject(startDir) {
  try {
    let dir = resolve(startDir || process.cwd());
    for (let i = 0; i < MAX_WALK_UP; i++) {
      if (
        existsSync(join(dir, "node_modules", "@raymondchins", "agentmap")) ||
        existsSync(join(dir, ".claude", "agentmap", "map.json"))
      ) {
        return true;
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
  } catch {
    // Never throw — treat as "not found".
  }
  return false;
}

const DEP_RE =
  /\b(import|require\s*\(|imported\s+by|depends|dependents?|dependency)\b|from\s+["']|(^|\|)\s*export\b/i;
const INTENT_RE =
  /\bwhere\s+is\b|\bwho\s+(imports|uses|renders)\b|\breuse\b|\b(existing|shared)\s+(util|component|hook|helper)\b/i;
const SYMBOL_RE = /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/;

function shouldNudge(tool, args) {
  const pattern = String(args?.pattern || args?.query || "");
  const cmd = String(args?.command || "");
  if (tool === "grep" && pattern) return DEP_RE.test(pattern) || INTENT_RE.test(pattern);
  if (tool === "bash" && cmd) {
    if (!/(^|[;&]\s*)(rg|ripgrep|grep|egrep|fgrep|ag|ack)\b/.test(cmd)) return false;
    return DEP_RE.test(cmd) || INTENT_RE.test(cmd) || SYMBOL_RE.test(cmd);
  }
  return false;
}

export const AgentmapNudge = async ({ client, directory }) => {
  // Computed ONCE at plugin load — OpenCode gives us `directory` (the project
  // cwd) here at factory time, not per tool-call, so there is no per-call cwd
  // to gate on. Falls back to process.cwd() if `directory` is ever absent.
  const projectHasAgentmap = hasAgentmapProject(directory);
  return {
    "tool.execute.before": async (input, output) => {
      if (!projectHasAgentmap) return;
      if (!shouldNudge(input.tool, output.args)) return;
      const message =
        "Structural search: prefer agentmap --any <query>, --relates <path>, or --find <symbol> before serial grep.";
      try {
        await client?.app?.log?.({
          body: { service: "agentmap", level: "info", message },
        });
      } catch {
        // advisory only
      }
    },
  };
};
