#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — PreToolUse nudge hook (Grep tool + Bash text-searchers)
//
//  Steers dependency / who-imports / reuse / component-usage / where-is-symbol
//  searches toward the agentmap repo-map instead of serial grep. NON-BLOCKING:
//  only ever injects a reminder via `additionalContext`; never denies the call.
//  Exits 0 on every path. Dependency-free (Node stdlib only) — Claude Code
//  pipes the tool-call JSON on stdin.
//
//  Why the Bash branch: the original hook only watched the Grep TOOL, so any
//  search run as raw `grep`/`rg` via Bash bypassed the nudge entirely — the
//  exact gap that let an agent forget agentmap and fall back to manual
//  Read/sed/awk. This closes it.
//
//  Heuristic: fires when the search looks like (a) a dependency hunt
//  (import/require/export / "from '..." / who-imports), (b) a component /
//  "where-is" / reuse lookup (a JSX component tag like <Heading, or where-is /
//  who-uses / reuse / existing-component intent words), (c) — Bash only — a
//  bare multi-hump PascalCase identifier (ProviderCard, TopProviders), almost
//  always a "where is this symbol / who uses it" hunt. A raw string or
//  Tailwind-class search (bg-white, text-3xl) and lowercase HTML-tag sweeps
//  (<div, <h1) produce NO output — no nagging.
//
//  Bash branch only fires when grep/rg/ag is the PRIMARY command (at start, or
//  after `;` / `&&` — NOT after a pipe, so `… | grep SomeError` log-filtering
//  stays silent).
//
//  Injection-safe: the user's pattern/command is ONLY regex-tested, never
//  interpolated into the emitted message or executed. Output is a single fixed
//  JSON object.
// ============================================================================

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw || "{}");
    const tool = String(payload.tool_name || "");
    const ti = payload.tool_input || {};

    // (a) Dependency / who-imports / reuse intent signals in the pattern itself.
    const DEP_RE =
      /\b(import|require\s*\(|imported\s+by|depends|dependents?|dependency)\b|from\s+["']|(^|\|)\s*export\b/i;

    // (b) JSX component open tag in the pattern (PascalCase, e.g. <Heading, <Hero,
    // <Motion.div). CASE-SENSITIVE on purpose (NO /i flag) — PascalCase-only keeps
    // raw HTML/content sweeps of <div>/<h1> silent, so it stays high-signal for
    // "where is this component used/defined".
    //
    // Denylist: common TS generic/utility type containers (e.g. <Promise<,
    // <Record<string) that look like a component tag but are NOT React components.
    // NOT ^-anchored — matches ANYWHERE, because the Bash branch tests the whole
    // command (the generic sits mid-string, e.g. `rg "<Promise<Foo>"`) and a
    // generic can also appear mid-pattern in Grep (e.g. useState<Promise>). The
    // `\b` after the name keeps real components like <PromiseCard / <MapView firing.
    const GENERIC_DENYLIST =
      /<(Promise|Array|Map|Set|Record|Partial|Readonly|Pick|Omit|Required|Exclude|Extract|NonNullable|ReturnType|Awaited|Parameters|InstanceType)\b/;
    const COMPONENT_TAG_RE = /<[A-Z][\w.]*/;

    // (c) Explicit reuse / "where-is" intent words (case-insensitive): "where is",
    // "who imports/uses/renders", "reuse", "existing/shared util|component|hook|helper",
    // "is there an existing/shared".
    const INTENT_RE =
      /\bwhere\s+is\b|\bwho\s+(imports|uses|renders)\b|\breuse\b|\b(existing|shared)\s+(util|component|hook|helper)\b|\bis\s+there\s+(an?\s+)?(existing|shared)\b/i;

    // (d) Bare multi-hump PascalCase identifier (e.g. ProviderCard, TopProviders).
    // Bash branch only. Two humps required so all-caps (TODO, API), single-word
    // (Error, Button) and lowercase (useState) stay silent → high signal, no
    // Tailwind/raw-string noise.
    const SYMBOL_RE = /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/;

    let fire = false;

    if (tool === "Grep") {
      const pattern = String(ti.pattern || "");

      // Defensive guard: pathological-input belt-and-suspenders.
      // If the pattern is unreasonably long, skip nudging entirely.
      if (pattern.length > 2000) {
        process.exit(0);
      }

      fire =
        !!pattern &&
        (DEP_RE.test(pattern) ||
          (COMPONENT_TAG_RE.test(pattern) && !GENERIC_DENYLIST.test(pattern)) ||
          INTENT_RE.test(pattern));
    } else if (tool === "Bash") {
      const cmd = String(ti.command || "");
      // Only when grep/rg/ag is the PRIMARY command (start, or after ; / && — NOT
      // after a pipe, so `… | grep SomeError` log-filtering stays silent). Then
      // test the whole command, plus the symbol rule for bare-identifier symbol
      // hunts.
      const SEARCHER_RE = /(^|[;&]\s*)(rg|ripgrep|grep|egrep|fgrep|ag|ack)\b/;
      if (SEARCHER_RE.test(cmd)) {
        // Guard: if any operand token references a non-source data file, stay
        // silent — e.g. `rg TypeError app.log` is log-filtering, not a
        // symbol/component hunt. Match on extension only (not inside quoted
        // patterns) by scanning whitespace-separated tokens for a data-file ext.
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
      const AM = "node node_modules/@raymondchins/agentmap/agentmap.mjs";
      const msg =
        "This looks like a dependency / component / who-imports / reuse / where-is-symbol " +
        "search. Use agentmap FIRST — it's faster than serial grep. Easiest: " +
        "`" + AM + " --any <query>` " +
        "(one command — auto-routes file → symbol → feature → live content). " +
        "Or be specific: `" + AM + " --relates <path>` (blast radius / who-imports), " +
        "`" + AM + " --find <symbol>` (reuse-before-rebuild / where a component is defined), " +
        "`" + AM + " --feature <name>` (files in a feature). " +
        "Rebuild the map with `npm run agentmap` (or `npx @raymondchins/agentmap`) if it's stale. " +
        "Only fall back to grep if agentmap doesn't cover it.";
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: msg,
          },
        }),
      );
    }
  } catch {
    // Never block on parse/other errors — stay silent.
  }
  process.exit(0);
});
