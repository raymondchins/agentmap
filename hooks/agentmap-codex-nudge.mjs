#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — Codex CLI PreToolUse gate (Bash grep/rg interceptor)
//
//  Codex CLI runs this synchronously BEFORE a Bash tool call, piping the
//  tool-call JSON on stdin and reading a JSON decision from stdout. Unlike the
//  Claude/Gemini nudges (which only INJECT context and never block), Codex
//  PreToolUse does NOT honor a non-blocking hint: `additionalContext` FAILS
//  OPEN and `permissionDecision:"ask"` is PARSED-BUT-UNSUPPORTED (marks the hook
//  run FAILED and lets the tool call proceed). The only response Codex actually
//  applies is `permissionDecision:"deny"` (with a `permissionDecisionReason`
//  surfaced back to the model) — or empty stdout + exit 0, which means
//  "no opinion, allow the call." So this hook is a SOFT GATE: it DENYs ONLY the
//  narrow, high-confidence structural-search case and otherwise stays silent
//  (= allow). A hard blanket-deny on all grep would drive uninstalls (agentmap
//  only covers TS/JS/Vue), so the fallbacks below all resolve to ALLOW.
//
//  ALLOW-FALLBACK (emit nothing, exit 0) when:
//   - grep/rg is not the PRIMARY command (only fires at start or after ; / && —
//     NOT after a pipe, so `… | grep SomeError` log-filtering is never blocked)
//   - an operand references a non-source data file (.log/.json/.md/.csv/…)
//   - the search does NOT look structural (raw string / Tailwind class / <div>
//     HTML sweep / lowercase identifier → not a dependency/component/symbol hunt)
//   - the command is pathologically long (belt-and-suspenders)
//   - AGENTMAP_CODEX_GATE=0 is set (global escape hatch — repeat-query / opt-out)
//   - stdin is unparseable or anything throws (never block on our own error)
//
//  Heuristic mirrors hooks/agentmap-nudge.mjs (the Claude Bash branch): fires on
//  (a) dependency / who-imports / reuse intent, (b) a PascalCase JSX component
//  tag (minus a TS-generic denylist), (c) explicit where-is / who-uses intent
//  words, (d) a bare multi-hump PascalCase identifier (ProviderCard) — almost
//  always a "where is this symbol / who uses it" hunt.
//
//  Injection-safe: the user's command is ONLY regex-tested, never interpolated
//  into the emitted reason or executed. Output is a single fixed JSON object.
//  Dependency-free (Node stdlib only). Copied into the project by
//  `agentmap --install-skill --platform codex`.
// ============================================================================
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ─── Project-presence gate ──────────────────────────────────────────────────
// This hook is distributed outside per-repo installs too (a stale
// `.codex/config.toml` block, a manually-copied hook), so without a check it
// can DENY greps in repos that have no agentmap at all. Same walk-up check as
// hooks/agentmap-nudge.mjs (kept as a standalone copy — these files are
// distributed separately, no shared import). MUST run before any deny path:
// see the call site below, which sits ahead of every structural check. Never
// throws.
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

function allow() {
  // Empty stdout + exit 0 = "no opinion"; Codex proceeds with the tool call.
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    // Global escape hatch: lets a user who hit a false-positive (or is doing a
    // deliberate repeat grep) turn the gate off without uninstalling.
    if (process.env.AGENTMAP_CODEX_GATE === "0") return allow();

    const payload = JSON.parse(raw || "{}");

    // Project-presence gate — MUST come before any deny path. `payload.cwd`
    // is the tool call's actual working directory (Codex PreToolUse input
    // always includes it); falls back to this process's own cwd if absent.
    if (!hasAgentmapProject(payload.cwd)) return allow();

    // Codex PreToolUse always reports tool_name "Bash" for shell; guard anyway so
    // an apply_patch / MCP tool call (if the matcher is ever widened) can't fire.
    const tool = String(payload.tool_name || "");
    if (tool && tool !== "Bash") return allow();

    const ti = payload.tool_input || {};
    // Bash uses tool_input.command (verified against the Codex hooks schema).
    const cmd = String(ti.command || "");
    if (!cmd || cmd.length > 2000) return allow();

    // Only when grep/rg/ag is the PRIMARY command (start, or after ; / && — NOT
    // after a pipe, so `… | grep SomeError` log-filtering stays allowed).
    const SEARCHER_RE = /(^|[;&]\s*)(rg|ripgrep|grep|egrep|fgrep|ag|ack)\b/;
    if (!SEARCHER_RE.test(cmd)) return allow();

    // Allow-fallback: if any operand token references a non-source data file,
    // it's log/data filtering, not a symbol/component hunt.
    const DATA_FILE_RE = /\.(log|txt|out|csv|tsv|jsonl|ndjson|json|md|ya?ml|xml)(\b|$)/i;
    if (cmd.split(/\s+/).some((tok) => DATA_FILE_RE.test(tok))) return allow();

    // (a) dependency / who-imports / reuse intent in the command text.
    const DEP_RE =
      /\b(import|require\s*\(|imported\s+by|depends|dependents?|dependency)\b|from\s+["']|(^|\|)\s*export\b/i;
    // (b) PascalCase JSX component tag, minus TS-generic containers that look
    //     like a tag but aren't React components.
    const GENERIC_DENYLIST =
      /<(Promise|Array|Map|Set|Record|Partial|Readonly|Pick|Omit|Required|Exclude|Extract|NonNullable|ReturnType|Awaited|Parameters|InstanceType)\b/;
    const COMPONENT_TAG_RE = /<[A-Z][\w.]*/;
    // (c) explicit where-is / who-uses / reuse intent words.
    const INTENT_RE =
      /\bwhere\s+is\b|\bwho\s+(imports|uses|renders)\b|\breuse\b|\b(existing|shared)\s+(util|component|hook|helper)\b|\bis\s+there\s+(an?\s+)?(existing|shared)\b/i;
    // (d) bare multi-hump PascalCase identifier (ProviderCard, TopProviders).
    const SYMBOL_RE = /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/;

    const structural =
      DEP_RE.test(cmd) ||
      (COMPONENT_TAG_RE.test(cmd) && !GENERIC_DENYLIST.test(cmd)) ||
      INTENT_RE.test(cmd) ||
      SYMBOL_RE.test(cmd);

    if (!structural) return allow();

    // High-confidence structural search → DENY and steer to agentmap. The reason
    // is surfaced back to the model so it can re-run via agentmap instead.
    const AM = "npx @raymondchins/agentmap";
    const reason =
      "agentmap gate: this looks like a dependency / component / who-imports / " +
      "where-is-symbol search. Run agentmap FIRST — it is faster and more " +
      "accurate than grep for structural questions. Easiest: `" + AM + " --any " +
      "<query>` (auto-routes file -> symbol -> feature -> live git-grep). Or be " +
      "specific: `" + AM + " --relates <path>` (blast radius / who-imports), `" +
      AM + " --find <symbol>` (reuse / where a component is defined), `" + AM +
      " --feature <name>`. If the map is stale, rebuild with `" + AM + "`. If " +
      "agentmap genuinely does not cover this (non-TS/JS/Vue file, raw string, or " +
      "you already tried it), re-run the SAME grep with AGENTMAP_CODEX_GATE=0 " +
      "prefixed to bypass this gate.";

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
    process.exit(0);
  } catch {
    // Never block on our own parse/other error — allow.
    return allow();
  }
});
