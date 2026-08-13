#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — Cursor beforeShellExecution gate (Bash grep/rg interceptor)
//
//  Cursor runs this synchronously BEFORE the agent executes a shell command,
//  piping the call JSON on stdin and reading a JSON decision from stdout. It is
//  one of only two Cursor events whose stdout actually gates the action
//  (`beforeShellExecution` and `beforeMCPExecution`); the rest are observers.
//
//  This is the Cursor sibling of hooks/agentmap-codex-nudge.mjs and shares its
//  heuristic verbatim. What differs is the wire format, and only that:
//
//    Codex   stdin  { tool_name, tool_input: { command }, cwd }
//    Cursor  stdin  { command, cwd, workspace_roots, hook_event_name, … }
//                   ^ command is TOP-LEVEL, not nested under tool_input.
//
//    Codex   stdout { hookSpecificOutput: { permissionDecision: "deny", … } }
//    Cursor  stdout { permission: "allow"|"deny"|"ask", user_message, agent_message }
//
//  SOFT GATE, same contract as Codex: DENY only the narrow, high-confidence
//  structural-search case, ALLOW everything else. A blanket deny on grep would
//  drive uninstalls — agentmap only covers TS/JS/Vue — so every fallback below
//  resolves to ALLOW.
//
//  ── Why both key spellings are emitted ──────────────────────────────────────
//  Cursor's own docs (cursor.com/docs/hooks and /docs/agent/hooks) specify
//  snake_case `user_message` / `agent_message`. Community type definitions and
//  at least one widely-read write-up specify camelCase `userMessage` /
//  `agentMessage`. Both cannot be right, and the failure mode of picking wrong
//  is SILENT: `permission: "deny"` still blocks, but the reason never reaches
//  the model, so the agent gets an unexplained refusal and retries the same
//  grep. That is exactly the bug this repo already shipped once with Gemini's
//  `additionalContext` (see hooks/agentmap-gemini-nudge.mjs).
//
//  So the deny payload carries BOTH spellings. Unknown keys are ignored by any
//  JSON consumer, the object stays valid under either schema, and the cost is
//  two duplicated strings. If Cursor ever documents one spelling normatively,
//  drop the other — do NOT drop both to "clean up".
//
//  ALLOW-FALLBACK (emit permission:"allow", exit 0) when:
//   - the repo has no agentmap (walk-up finds neither node_modules install nor
//     a built map) — this hook can land in repos agentmap does not cover
//   - grep/rg is not the PRIMARY command (only fires at start or after ; / && —
//     NOT after a pipe, so `… | grep SomeError` log-filtering is never blocked)
//   - an operand references a non-source data file (.log/.json/.md/.csv/…)
//   - the search does NOT look structural (raw string / Tailwind class / <div>
//     HTML sweep / lowercase identifier → not a dependency/component/symbol hunt)
//   - the command is pathologically long (belt-and-suspenders)
//   - AGENTMAP_CURSOR_GATE=0 is set (global escape hatch — repeat-query / opt-out)
//   - stdin is unparseable or anything throws (never block on our own error)
//
//  Injection-safe: the user's command is ONLY regex-tested, never interpolated
//  into the emitted message or executed. Output is a single fixed JSON object.
//  Dependency-free (Node stdlib only). Copied into the project by
//  `agentmap --install-skill --platform cursor`.
// ============================================================================
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ─── Project-presence gate ──────────────────────────────────────────────────
// Identical walk-up to hooks/agentmap-codex-nudge.mjs, kept as a standalone
// copy on purpose — these files are distributed one-by-one into user repos and
// must not import each other. MUST run before any deny path. Never throws.
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
  // Explicit allow rather than empty stdout. Cursor treats unparseable output
  // as fail-open too, but "no opinion" and "I looked and it is fine" should not
  // be the same bytes — an explicit allow is what makes a hook log readable.
  process.stdout.write(JSON.stringify({ permission: "allow" }));
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    // Global escape hatch: lets a user who hit a false-positive (or is doing a
    // deliberate repeat grep) turn the gate off without uninstalling.
    if (process.env.AGENTMAP_CURSOR_GATE === "0") return allow();

    const payload = JSON.parse(raw || "{}");

    // Guard the event name so a mis-registered hook (someone wiring this into
    // beforeMCPExecution, whose payload has no `command`) cannot deny anything.
    const event = String(payload.hook_event_name || "");
    if (event && event !== "beforeShellExecution") return allow();

    // Cursor puts the shell command at the TOP level — not under tool_input.
    const cmd = String(payload.command || "");
    if (!cmd || cmd.length > 2000) return allow();

    // Project-presence gate — MUST come before any deny path. Prefer the call's
    // own cwd; fall back to the first workspace root, then this process's cwd.
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
    const startDir = payload.cwd || roots[0] || process.cwd();
    if (!hasAgentmapProject(startDir)) return allow();

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

    // High-confidence structural search → DENY and steer to agentmap.
    const AM = "npx @raymondchins/agentmap";
    const agentMessage =
      "agentmap gate: this looks like a dependency / component / who-imports / " +
      "where-is-symbol search. Run agentmap FIRST — it is faster and more " +
      "accurate than grep for structural questions. Easiest: `" + AM + " --any " +
      "<query>` (auto-routes file -> symbol -> feature -> live git-grep). Or be " +
      "specific: `" + AM + " --relates <path>` (blast radius / who-imports), `" +
      AM + " --find <symbol>` (reuse / where a component is defined), `" + AM +
      " --feature <name>`. If the map is stale, rebuild with `" + AM + "`. If " +
      "agentmap genuinely does not cover this (non-TS/JS/Vue file, raw string, or " +
      "you already tried it), re-run the SAME command with AGENTMAP_CURSOR_GATE=0 " +
      "prefixed to bypass this gate.";
    // The human sees a one-liner, not the model's instruction block.
    const userMessage =
      "agentmap blocked a structural grep and asked the agent to use agentmap " +
      "instead. Bypass once with AGENTMAP_CURSOR_GATE=0, or remove the hook from " +
      ".cursor/hooks.json.";

    process.stdout.write(
      JSON.stringify({
        permission: "deny",
        // Both spellings on purpose — see the header. Dropping either risks a
        // silently-swallowed reason depending on which schema Cursor honours.
        user_message: userMessage,
        agent_message: agentMessage,
        userMessage,
        agentMessage,
      }),
    );
    process.exit(0);
  } catch {
    // Never block on our own parse/other error — allow.
    return allow();
  }
});
