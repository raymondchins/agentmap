# agentmap — Project Instructions

> **Auto-loaded every Claude Code session in this repo.**
>
> Universal rules live at `~/.claude/CLAUDE.md`. This file = project-specific only.

## ⚠️ This is a PUBLIC OSS repo, not one of Ray's apps

Published to npm as `@raymondchins/agentmap` and to the MCP registry as `io.github.raymondchins/agentmap`. Consequences that override the usual defaults:

- **Code changes go through a PR**, not a direct push. `main` is not branch-protected, so nothing stops you — the discipline is the point. CI (`.github/workflows/ci.yml`) runs on both PRs and pushes to `main`, so a direct push is still gated, just gated *after* the fact. Docs-only changes that touch no shipped file may go direct.
- **A release is a deliberate act.** `chore(release): X.Y.Z` commits bump the version; the tag triggers publish. Don't bump the version as a side effect of a feature PR.
- **`package.json` `files` controls what ships.** A new runtime file that isn't listed there is missing from the published tarball even though it works locally. Current list: `agentmap.mjs`, `mcp.mjs`, `hooks`, `skills`, `.claude-plugin`, `server.json`, `NOTICE`.
- **Assume strangers read the diff.** No Ray-specific paths, no `/Users/raymondchin/...`, no internal project names in source or docs.

## Read before editing

1. **`CONTRIBUTING.md`** — the real rules live there: scope, the near-zero-deps rule, the freshness invariant, style, PR process. **Read it, don't re-derive it from this file.**
2. `README.md` (50KB) — user-facing surface. The `## Commands` section is the CLI contract.
3. `ROADMAP.md` (96KB) + `CHANGELOG.md` (78KB) — history and intent. Check before proposing something already decided against.
4. `EVAL.md` — the measured claims. Any number quoted in the README must be reproducible from `eval/`.

## Layout

```
agentmap.mjs          — the entire CLI (246KB, single file, by design)
mcp.mjs               — MCP server wrapper
hooks/                — per-platform nudge hooks + the shared installer
  agentmap-nudge.mjs        (Claude Code)
  agentmap-codex-nudge.mjs  · agentmap-gemini-nudge.mjs
  opencode-agentmap-nudge.js · cursor-rule.mdc
  post-commit               — the auto-refresh hook shipped to consumers
  install.mjs · install-helpers.mjs · hooks.json · guidance.md
skills/agentmap/      — the Claude Code skill
.claude-plugin/       — plugin + marketplace manifests
test/                 — 120 test files, `node --test`
eval/ · benchmark/    — the reproducible measurements behind README claims
examples/ · assets/ · docs/
```

**Only runtime dependency is `ts-morph`.** See the near-zero-deps rule in `CONTRIBUTING.md` before adding anything.

## Hard invariants

- ❌ **Don't break the freshness invariant.** Never serve the cache on a dirty tree or a mismatched SHA. **Bump `SCHEMA_VERSION`** whenever the shape of `map.json` changes so stale caches are rejected instead of silently misread. `CONTRIBUTING.md` §"The freshness invariant" is normative.
- ❌ **Don't add a runtime dependency** without reading the near-zero-deps rule and having a reason that survives it.
- ❌ **Don't change CLI flag behaviour without updating `README.md` §Commands** — the README is the contract users read, and drift there is a bug report.
- ❌ **Don't edit `hooks/post-commit` casually.** It ships to every consumer repo and runs on every commit of theirs. It already carries a runaway guard (single-instance lock + process-tree kill + 120s cap) added after an orphan pegged a core for 20+ minutes. Preserve it.
- ❌ **Don't quote an unmeasured performance number.** Anything in `README.md`/`EVAL.md` must come from `eval/` or `benchmark/`.

## Verification

```bash
npm test
```

120 test files via `node --test test/*.test.mjs test/**/*.test.mjs`. The publish workflow additionally runs `node agentmap.mjs --hubs` (smoke) and `npm pack --dry-run` (tarball contents) — run both locally before proposing a release.

Self-map this repo with `npm run map` (= `node agentmap.mjs`). Note it maps itself from the **repo root**, not `node_modules/` — the local `.git/hooks/post-commit` reflects that and differs from the hook shipped to consumers.

## Generated artifacts (all gitignored)

- `.claude/agentmap/map.json` — self-map, 77 files. Refresh: `npm run map`.
- `graphify-out/` — knowledge graph (840 nodes / 1.417 edges). Rebuilt by the post-commit hook.
- `tmp/`, `.serena/`, `mcp-publisher`.
