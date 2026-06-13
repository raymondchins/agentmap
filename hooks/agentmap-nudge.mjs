#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — PreToolUse(Grep) nudge hook
//
//  Steers dependency / who-imports / reuse / component-usage greps toward the
//  agentmap repo-map instead of serial grep. NON-BLOCKING: only ever injects a
//  reminder via `additionalContext`; never denies the Grep. Exits 0 on every
//  path. Dependency-free (Node stdlib only) — Claude Code pipes the tool-call
//  JSON on stdin.
//
//  Heuristic: fires when the grep PATTERN looks like (a) a dependency hunt
//  (import/require/export / "from '..." / who-imports), (b) a component /
//  "where-is" / reuse lookup (a JSX component tag like <Heading, or where-is /
//  who-uses / reuse / existing-component intent words). A raw string or
//  Tailwind-class search (e.g. "bg-white", "text-3xl") and lowercase HTML-tag
//  sweeps (<div, <h1) produce NO output — no nagging.
//
//  agentmap's `--any` router falls back to a live git-grep on its own, so it
//  still covers the raw-string / copy case — but only when the agent reaches
//  for it deliberately, not on every content sweep.
// ============================================================================

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw || "{}");
    const ti = payload.tool_input || {};
    const pattern = String(ti.pattern || "");

    // Defensive guard: pathological-input belt-and-suspenders.
    // If the pattern is unreasonably long, skip nudging entirely.
    if (pattern.length > 2000) {
      process.exit(0);
    }

    // (a) Dependency / who-imports / reuse intent signals in the pattern itself.
    const DEP_RE =
      /\b(import|require\s*\(|imported\s+by|depends|dependents?|dependency)\b|from\s+["']|(^|\|)\s*export\b/i;

    // (b) JSX component open tag in the pattern (PascalCase, e.g. <Heading, <Hero,
    // <Motion.div). CASE-SENSITIVE on purpose (NO /i flag) — PascalCase-only keeps
    // raw HTML/content sweeps of <div>/<h1> silent, so it stays high-signal for
    // "where is this component used/defined".
    //
    // Denylist: common TS generic/utility type containers that start with an
    // uppercase letter but are NOT React components. Without this, a grep for
    // `<Promise<` or `<Record<string` fires the nudge spuriously.
    const GENERIC_DENYLIST =
      /^<(Promise|Array|Map|Set|Record|Partial|Readonly|Pick|Omit|Required|Exclude|Extract|NonNullable|ReturnType|Awaited|Parameters|InstanceType)\b/;
    const COMPONENT_TAG_RE = /<[A-Z][\w.]*/;

    // (c) Explicit reuse / "where-is" intent words (case-insensitive): "where is",
    // "who imports/uses/renders", "reuse", "existing/shared util|component|hook|helper",
    // "is there an existing/shared".
    const INTENT_RE =
      /\bwhere\s+is\b|\bwho\s+(imports|uses|renders)\b|\breuse\b|\b(existing|shared)\s+(util|component|hook|helper)\b|\bis\s+there\s+(an?\s+)?(existing|shared)\b/i;

    if (
      pattern &&
      (DEP_RE.test(pattern) ||
        (COMPONENT_TAG_RE.test(pattern) && !GENERIC_DENYLIST.test(pattern)) ||
        INTENT_RE.test(pattern))
    ) {
      const msg =
        "This Grep looks like a dependency / component / who-imports / reuse search. " +
        "Use agentmap FIRST — it's faster than serial grep. Easiest: " +
        "`npx @raymondchins/agentmap --any <query>` (or `node agentmap.mjs --any <query>`) " +
        "— one command, auto-routes file → symbol → feature → live content. " +
        "Or be specific: `--relates <path>` (blast radius / who-imports), " +
        "`--find <symbol>` (reuse-before-rebuild / where a component is defined), " +
        "`--feature <name>` (files in a feature), `--hubs` (most-imported files). " +
        "Rebuild the map with `npx @raymondchins/agentmap` (or `node agentmap.mjs`) if it's stale. " +
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
