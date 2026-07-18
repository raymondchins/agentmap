#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Gemini CLI BeforeTool nudge — non-blocking context when a search looks like
// dependency / blast-radius / reuse work. Stdlib only; copied into the project
// by `agentmap --install-skill --platform gemini`.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Project-presence gate — see hooks/agentmap-nudge.mjs for the full
// rationale (this hook ships at global scope too via `~/.gemini/settings.json`,
// so without it it fires in every repo, agentmap or not). Standalone copy —
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

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw || "{}");

    // Silent no-op ("{}", same as every other non-fire path) in a repo
    // without agentmap. `payload.cwd` is the tool call's actual working
    // directory; falls back to this process's own cwd if absent.
    if (!hasAgentmapProject(payload.cwd)) {
      process.stdout.write("{}");
      process.exit(0);
    }

    const tool = String(payload.tool_name || "");
    const ti = payload.tool_input || {};

    const DEP_RE =
      /\b(import|require\s*\(|imported\s+by|depends|dependents?|dependency)\b|from\s+["']|(^|\|)\s*export\b/i;
    const GENERIC_DENYLIST =
      /<(Promise|Array|Map|Set|Record|Partial|Readonly|Pick|Omit|Required|Exclude|Extract|NonNullable|ReturnType|Awaited|Parameters|InstanceType)\b/;
    const COMPONENT_TAG_RE = /<[A-Z][\w.]*/;
    const INTENT_RE =
      /\bwhere\s+is\b|\bwho\s+(imports|uses|renders)\b|\breuse\b|\b(existing|shared)\s+(util|component|hook|helper)\b|\bis\s+there\s+(an?\s+)?(existing|shared)\b/i;
    const SYMBOL_RE = /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/;

    let fire = false;
    const pattern = String(ti.pattern || ti.query || ti.content || "");
    const cmd = String(ti.command || ti.cmd || "");

    if (/grep|search|ripgrep/i.test(tool)) {
      if (pattern.length > 0 && pattern.length <= 2000) {
        fire =
          DEP_RE.test(pattern) ||
          (COMPONENT_TAG_RE.test(pattern) && !GENERIC_DENYLIST.test(pattern)) ||
          INTENT_RE.test(pattern);
      }
    } else if (/shell|bash|terminal|command/i.test(tool) && cmd) {
      const SEARCHER_RE = /(^|[;&]\s*)(rg|ripgrep|grep|egrep|fgrep|ag|ack)\b/;
      if (SEARCHER_RE.test(cmd)) {
        const DATA_FILE_RE = /\.(log|txt|out|csv|tsv|jsonl|ndjson|json|md|ya?ml|xml)(\b|$)/i;
        const hasDataFileTarget = cmd.split(/\s+/).some((tok) => DATA_FILE_RE.test(tok));
        if (!hasDataFileTarget) {
          fire =
            DEP_RE.test(cmd) ||
            (COMPONENT_TAG_RE.test(cmd) && !GENERIC_DENYLIST.test(cmd)) ||
            INTENT_RE.test(cmd) ||
            SYMBOL_RE.test(cmd);
        }
      }
    }

    if (fire) {
      const msg =
        "Dependency / blast-radius / reuse search detected. Prefer agentmap first: " +
        "`npx @raymondchins/agentmap --any <query>` (file → symbol → feature → git-grep), " +
        "`--relates <path>`, `--find <symbol>`. Rebuild with `npx @raymondchins/agentmap` if stale.";
      // Gemini CLI BeforeTool supports a top-level `systemMessage` (surfaced to
      // the model), but NOT `hookSpecificOutput.additionalContext` (parsed &
      // dropped on BeforeTool). Emit `systemMessage` so the nudge reaches the model.
      process.stdout.write(JSON.stringify({ systemMessage: msg }));
    } else {
      process.stdout.write("{}");
    }
  } catch {
    process.stdout.write("{}");
  }
  process.exit(0);
});
