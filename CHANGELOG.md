# Changelog

All notable changes to agentmap are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Codex CLI PreToolUse gate.** `--install-skill --platform codex` now installs a
  real PreToolUse hook (`.codex/config.toml` + a copied `agentmap-codex-nudge.mjs`),
  not just docs — Codex moves from docs-only to live enforcement. It denies only the
  narrow, high-confidence structural-search case (bare-symbol / dependency / component
  grep) with a reason steering to agentmap, and allows everything else (piped
  log-filters, data-file operands, non-structural sweeps); `AGENTMAP_CODEX_GATE=0`
  bypasses. (Codex only honors deny/allow on PreToolUse — an `ask` / `additionalContext`
  fails open, so a soft nudge can't work there.)
- **MCP Registry-ready.** A repo-root `server.json` (schema 2025-12-11, name = the
  existing `mcpName` `io.github.raymondchins/agentmap`) lets `mcp-publisher publish`
  list agentmap in the official MCP Registry.

### Changed
- **Honest competitive positioning.** The README no longer implies the agent-loop
  wiring (post-commit refresh + `PreToolUse` nudge) is unmatched — it isn't. Reframed
  around agentmap's real, defensible wedge: compiler-grade `ts-morph` TS/JS accuracy
  (tsconfig/vite/webpack aliases, `#imports`, workspaces all resolve) backed by a
  published accuracy eval. Tagline → "The TS/JS-accurate repo map"; the name-collision
  note is strengthened up top; `package.json` description + keywords broadened.

## [0.12.1] - 2026-07-04

### Added
- **package.json `"imports"` subpath resolution.** Self-referencing internal
  specifiers (`import x from '#lib/util'` / `#internal/*`) now resolve to their
  source (JSON-parsed, never executed), completing the alias story alongside
  tsconfig / vite / workspace resolution. A repo without an `"imports"` field is
  byte-identical (verified A/B on a frozen 519-file corpus).

### Performance
- **In-process MCP server.** The 8 MCP tools now answer in-process against a map
  parsed once (invalidated by the same freshness key the CLI uses) instead of
  spawning a fresh `node agentmap.mjs` per call — the per-call double-Node-spawn +
  whole-repo reparse that was the entire experience for Cursor / Cline /
  Claude-Desktop users (MCP is their only integration). Tool outputs are
  byte-identical to the old spawn path (all 8 tools across 17 query/edge combos;
  `agentmap --mcp` verified end-to-end, no cyclic-import deadlock); the CLI path
  is untouched. Warm query ~93ms spawn -> ~22ms in-process.

### Security
Fixes from a full security audit — which also confirmed a genuinely solid
posture: **zero** committed secrets across full history, `npm audit` clean, and
the config readers (vite/webpack/tsconfig/package.json) are AST/JSON-parse only
and **never execute** untrusted repo config.
- **ReDoS in the `.agentmapignore` matcher (real DoS, fixed).** A line of
  consecutive `*` compiled to adjacent `[^/]*` groups (catastrophic
  backtracking) — a `*`x50 line hung the per-path matcher ~80s, freezing
  `build()`, the post-commit auto-refresh hook, and the MCP server. Runs of `*`
  are now collapsed before translating (this glob subset has no `**` semantics)
  and a line-length cap is applied; a poisoned ignore file builds in <1.5s. +test.
- **Supply-chain hardening.** All 9 GitHub Actions are pinned to full commit
  SHAs (notably the third-party `gitleaks-action` in the `NPM_TOKEN` publish
  path); a `dependabot.yml` (npm + github-actions) keeps the pins current.
- **MCP untrusted-content fence.** The `--any` content fallback returns raw
  git-grep repository bytes; the MCP server now appends an explicit
  untrusted-data marker (a second content block, so `content[0]` stays
  byte-identical to the CLI) so a planted "ignore previous instructions" in an
  ordinary file reads as DATA, not a command.
- **`--install-hooks` no longer silently clobbers an existing `post-commit`
  hook** — a user's own hook is backed up to `post-commit.pre-agentmap` with a
  warning before agentmap's hook is written.
- **SECURITY.md** supported-version line updated `0.9.x` -> `0.12.x`.

## [0.12.0] - 2026-07-04

### Added
- **Map-health signal.** Every clean build now reports `edgeCoverage` (the share of
  repo-local-looking import sites that resolved to an in-project edge) and a `degraded`
  flag in `map.json` and the `--json` build output, and prints one honest stderr line
  when the map is empty (`0 source files found …`) or degraded (`N files, K import
  edges resolved — most imports unresolved …`). Turns a silently broken/empty map — the
  moment a new user assumes the tool doesn't work and uninstalls — into a clear, fixable
  signal. Healthy repos (coverage ~1) never trip it.
- **vite / vitest / webpack `resolve.alias` resolution.** A repo that aliases `@/` only
  in `vite.config` (the default `npm create vite` shape, not `tsconfig`) previously
  produced a fully inert map — zero resolved edges. The alias object is now read from the
  config's AST **without executing the config** and merged with `tsconfig` `paths`
  (tsconfig wins on conflict; function/regex aliases are deferred).
- **Workspace cross-package resolution (pnpm/npm/yarn).** `import '@org/pkg'` and its
  subpaths now resolve to the target package's source across package boundaries, so
  blast-radius and hub ranking no longer silently break at the monorepo package wall.
- **`.agentmapignore`.** A repo-root ignore file (gitignore-style subset: anchored `/`,
  dir `/`, `*` globs, `#` comments) excludes extra paths beyond the built-in
  `node_modules`/`.git`/`.next` skip list.
- **Claude Code plugin + marketplace + MCP Registry name.** `.claude-plugin/{plugin,
  marketplace}.json` make `/plugin marketplace add raymondchins/agentmap` +
  `/plugin install agentmap@agentmap` bundle the skill, the PreToolUse nudge, and the
  stdio MCP server in one auto-updating install (validated with `claude plugin validate
  --strict`). `mcpName` added to `package.json` for the MCP Registry. README gains an
  honest per-platform onboarding matrix (live-hook vs MCP vs docs-only) and a copy-paste
  `.cursor/mcp.json`.

### Changed
- **`.d.ts` files are excluded from the symbol ranking by default.** A generated
  declaration file (supabase/prisma/protobuf types, `next-env.d.ts`) no longer floods
  `--find`/`--symbols`/`--hubs` or hijacks the top hub. `.d.ts` files remain live
  import-resolution targets (edges to them are preserved); `--include-dts` restores the
  old behavior via a separate cache (`map.dts.json`), so the default `map.json` is
  untouched. **This changes the map for any repo with `.d.ts` files.**

### Fixed
- **PreToolUse nudge now fires on a bare-symbol `Grep`.** `{Grep, pattern:"ProviderCard"}`
  — the single most common structural search on Claude Code — previously never nudged,
  because the bare-PascalCase rule was gated to the Bash branch only. The emitted command
  is also now `npx @raymondchins/agentmap` instead of a `node node_modules/…` path that
  ENOENTs on npx/global installs (the README's headline install), which had taught the
  agent the tool was broken and driven a permanent grep fallback.
- **Gemini nudge now actually injects.** It emitted `hookSpecificOutput.additionalContext`
  on a `BeforeTool` event, which Gemini CLI silently drops — so `--install-skill` wired
  it and `--doctor` reported it installed, but it never reached the model. Now emits a
  top-level `systemMessage` (a BeforeTool-supported, model-visible field).
- **Correctness quick-wins (Batch 5).** Six independent resolution/robustness bugs,
  each found + confirmed with a repro and covered by a regression test:
  - **tsconfig `extends` origin** — inherited `baseUrl`/`paths` now resolve against
    the base config's own directory (anchored absolute at read time), not the child's,
    so monorepo shared-config alias edges resolve correctly instead of being dropped
    or mis-wired to a same-named local file.
  - **Longest-prefix alias precedence** — overlapping `paths` (e.g. `@/*` +
    `@/components/*`) now follow TypeScript's rule (exact, then longest fixed prefix)
    instead of first-declared order.
  - **Dirty tsconfig busts the cache** — editing `tsconfig.json`/`jsconfig.json`
    (which changes alias resolution for every file) now invalidates the cache; before,
    a config-only edit served a stale map with wrong import edges.
  - **Rename to a non-source path** — `git mv foo.ts foo.txt` now busts the cache
    (the vanished source file is removed from the map) instead of leaving a ghost.
  - **Non-ASCII / special-char filenames** — files like `src/café.ts` no longer
    silently disappear from the map (`git ls-files -z` + `core.quotePath=off`).
  - **Prototype-pollution in `resolveFile`** — `--any constructor` / `--relates toString`
    (any `Object.prototype` name) no longer crash (prose) or fabricate a false file
    hit (JSON/MCP); uses `Object.hasOwn`.

### Performance
- **Capped `--find`/`--any` symbol matches (Batch 3).** A broad symbol query used to
  emit every matching export (thousands / ~93k tokens on a large repo, defeating the
  token-savings point). Matches are now ranked by the containing file's PageRank and
  capped to 50, with a "showing top N of M by pagerank — narrow your query" footer in
  prose and `total`/`shown`/`truncated` (`--find`) and `symbolsTotal`/`symbolsTruncated`
  (`--any`) in JSON. Ranking keeps the most important matches when truncated; small
  result sets are unaffected.

## [0.11.0] - 2026-07-03

### Performance
- **Dirty-tree caching (Batch 3).** A dirty git working tree no longer re-parses the
  whole repo on every query — the #1 real-world cost, since agents work on dirty
  trees essentially always.
  - **Tier 1 — dirty-map cache (default, on).** The dirty build is cached to
    `.claude/agentmap/map.dirty.json`, keyed by `sha1(HEAD + dirty-file
    path:mtime:size)`. Back-to-back queries on an unchanged dirty tree reuse ONE
    rebuild (content-os 365 files: ~1.8s → ~0.12s, **~15×**). The clean `map.json`
    is never clobbered by a dirty build, so the dirty→clean transition serves the
    clean cache with no extra rebuild (also closes the old cache-poison bug).
    Byte-identical to the previous dirty output; verified on a fixed corpus.
  - **Tier 2 — true incremental (experimental, opt-in via `AGENTMAP_INCREMENTAL=1`).**
    When every change is a MODIFICATION of a file already in the map, agentmap
    re-parses ONLY the changed files (against empty ts-morph stubs of the rest) and
    re-runs the cheap global assembly — byte-identical to a full rebuild at a
    fraction of the cost (dirty-1 ~1.8s → ~0.62s, **~2.9×**). It declines to a full
    dirty build (Tier-1 cached) for adds/deletes/renames, re-export barrels,
    CommonJS `module.exports`, monorepo nested tsconfig/package.json, and laundered
    default re-exports. Three rounds of adversarial verification (20 import-resolution
    shapes across 7 real repos) found a tail of isolated-reparse edge cases where an
    ungated modify could still diverge (`.d.ts` edges, `package.json` `exports`
    field, barrel+target combos), so Tier 2 ships **off by default** until that tail
    is exhausted; the proven byte-identical Tier 1 is the default win. On any
    miss/error it falls back to a full build.
  - Clean builds persist a raw per-file facts snapshot to `.claude/agentmap/facts.json`
    for the incremental rebuild. `map.json` output is unchanged (byte-identical).

### Added
- **Tag-triggered publish workflow** (`.github/workflows/publish.yml`) — pushing a `v*`
  tag runs the full test gate, then publishes to npm with **provenance** (OIDC-signed
  supply-chain attestation, only possible from CI) and cuts a GitHub Release. Guards
  against tag/`package.json` version drift. One-time setup: add an npm Automation token
  as the `NPM_TOKEN` repo secret. (Batch 4 — release engineering.)

### Changed
- **README trust markers** — states the privacy posture ("fully local — no network calls,
  no telemetry", verified: zero `fetch`/`http` in source) and a name-collision caveat
  (`npx agentmap` unscoped is an unrelated package; always use `@raymondchins/agentmap`).

## [0.10.0] - 2026-07-03

### Added
- **Programmatic API — agentmap.mjs is now importable with zero side effects.** The
  CLI arg-parse + dispatch moved inside a `main()` guarded by an `import.meta.url`
  check (the same one `mcp.mjs` uses), so `import("@raymondchins/agentmap")` no longer
  executes the CLI or writes a cache into the importer's cwd. It exports the pure
  building blocks: `pagerank`, `rankSymbols`, `identMul`, `resolveFile`,
  `extractVueScripts`, `stripJsonComments`, `extractFacts`, `build`, `ensureFresh`,
  `readPackageVersion`. (Batch 2 — modularization; unblocks in-process MCP + unit tests.)
- **`extractFacts()` backend seam.** `build()` is split into `extractFacts()` — the only
  code that knows ts-morph / Vue SFCs, returning per-file facts (exports, imports,
  imported symbols, re-exports, default-export name) — and a backend-agnostic `build()`
  that assembles the graph, PageRank, symbol ranking, and cache from those facts. A
  second language backend becomes a drop-in producer of the same shape.
- **In-process unit tests** (`test/unit.test.mjs`) exercising the exported pure functions
  directly (no subprocess spawn), including the `extractFacts` seam contract.
- **Command-table validation.** A declarative command table now rejects conflicting
  commands (`--map --doctor`) and orphan sub-flags (`--focus` with no `--map`, `--platform`
  with no `--install-skill`, …) with a clear usage error (exit 2) instead of silently
  running whichever branch matched first.
- **`focusResolved` in `--map --json` output** — `true`/`false` when `--focus` was
  requested (resolved or not), omitted when no `--focus` was passed. The structured half
  of the exit-code signal below.

### Changed
- **Exit-code contract tightened.** Exit 1 is now reserved for "query had zero results"
  — and an unresolved `--map --focus <no-match>` joins that bucket (it used to silently
  degrade to the global digest at exit 0; it still prints the digest, now at exit 1 with
  `focusResolved:false`). Maintenance-command failures (`--install-hooks`, `--install-skill`,
  `--setup-mcp`, `--doctor`, `--hook-status`, `--mcp`) now exit **3** instead of colliding
  with the exit-1 "zero results" bucket. USAGE + the MCP classifier comment updated to match.
- **Writer/checker pairs unified.** `setupMcp` (writer) and `collectMcpStatus` (checker) now
  read one `MCP_TARGETS` table; `installHooks` and `collectHookStatus` share one set of
  hook-wiring identifiers + a `nudgeMatcherWired` predicate — no more parallel literals kept
  in sync by comment. Behavior-identical.
- **Internal refactor only — map output is byte-identical.** The source-extension list
  (previously hardcoded in 5 places) is hoisted into one per-backend descriptor
  (`CODE_EXT` / `SOURCE_EXT`), and the relative-specifier branch of `resolveSpec` (which
  re-implemented `tryResolveAt` behind a `join` local that shadowed `joinPosix`) collapses
  onto the shared helpers. No change to the map, hubs, rankings, or exit codes — verified
  byte-identical against the pre-refactor build.
- **Housekeeping.** Removed a dead `statSync` import; `--version` now reuses the exported
  `readPackageVersion()` instead of re-reading `package.json` inline.

### Security
- **Expanded the content-search secret denylist.** The `--any` / MCP content fallback now also
  excludes SSH private keys (`id_ed25519*`, `id_ecdsa*`), keystores (`*.p8`, `*.jks`,
  `*.keystore`), and credential dotfiles (`.npmrc`, `.netrc`, `.git-credentials`, `.pgpass`,
  `.htpasswd`, `.pypirc`) at any depth. Deliberately NOT a broad `token` name match — that
  would over-exclude ordinary source like `tokenizer.ts`. SECURITY.md + regression tests updated.
- **Post-commit hook no longer runs a repo-local `./agentmap.mjs` by default.** A working-tree
  `agentmap.mjs` is attacker-plantable (any branch/PR can add it), so the hook firing on the
  next commit was arbitrary code execution. Repo-local execution now requires an explicit
  `AGENTMAP_HOOK_ALLOW_LOCAL=1` opt-in (for developing agentmap itself); by default the hook
  runs only the installed package — `node_modules/.bin/agentmap`, a PATH binary verified to be
  `@raymondchins/agentmap`, or `npx @raymondchins/agentmap` — which also closes the bare-`agentmap`
  PATH-hijack fallback. Replaces the previous `AGENTMAP_HOOK_NO_LOCAL` opt-out.
- **Content-search secret exclusion now matches plain secret files.** The `--any` denylist used
  `*.password*` (only `foo.password.ts`); it now uses `*password*` so `password.txt` /
  `passwords.json` are excluded too.

### Fixed
- **MCP server no longer reports crashes as "no results".** Exit code 1 is overloaded (the CLI
  uses it for zero-results, but it is also Node's uncaught-exception code), so a hard crash was
  returned to the client as a successful empty answer. Exit-1-with-empty-stdout is now surfaced
  as `isError`; genuine zero-result queries (which always print JSON to stdout) are unaffected.
  Spawn failures whose `err.code` is a string (`ENOENT`, `EACCES`, …) are now detected too.
- **CI ran only part of the test suite.** The workflow ran `node --test test/*.test.mjs`
  (116 tests), silently skipping the entire `test/vue-sfc/` suite; it now runs `npm test`
  (159 tests).

### Docs
- Truth-synced `SECURITY.md`, `README.md`, `hooks/INSTALL.md`, and `CONTRIBUTING.md`: corrected
  the cache path (`.claude/agentmap/map.json`), removed the nonexistent `--refresh` flag and the
  removed `scripts/agentmap.mjs` lookup, fixed the sensitive-file exclusion list, added the
  `--setup-mcp` flag and Vue SFC support to the README, and corrected the nudge verify commands
  (they need `tool_name`).

## [0.9.0] - 2026-06-16

### Added
- **`--doctor`** — a read-only harness health report that checks, in one place, the git
  `post-commit` hook, the `PreToolUse` nudge and its `.claude/settings.json` wiring, installed
  skills / Cursor rule freshness vs the `package.json` version, MCP config entries for
  OpenCode / Antigravity, and map-cache presence/freshness. Always exits 0 and suggests fix
  commands (`--install-hooks`, `--install-skill`, `--setup-mcp`) but never writes files. Pair
  with `--json` for a structured report.

## [0.8.0] - 2026-06-15

### Added
- **`--install-skill` platform expansion** (#6, #12, @muhajirdev) — `codex`, `opencode`, `gemini`, `antigravity`, `copilot` with paths aligned to each platform's documented skill directories. Also merges always-on `GEMINI.md` / `AGENTS.md` blocks, Gemini CLI `BeforeTool` hooks, and OpenCode plugin (same `--install-skill` command — no separate flag).

### Changed
- **`--platform all` default set** — now installs claude, cursor, codex, opencode, gemini, antigravity, copilot. Legacy `agents` is opt-in (`--platform agents`). Global `all` no longer writes `~/.agents/skills/` by default; use `antigravity` (`~/.gemini/config/skills/`) or explicit `agents` for v0.7.0 `~/.agents/` behavior.

### Fixed
- **Monorepo tsconfig path aliases** (#9, @muhajirdev) — `--relates` no longer undercounts dependents when a repo imports through tsconfig `paths` aliases (`@/*`, `#/*`, `~/*`) defined at a non-root package config. Alias-config discovery now also follows `extends`, so a package tsconfig that only `extends` a shared base (Turborepo `tsconfig.base.json` holding all `paths`) still contributes its inherited `baseUrl`/`paths`. Recursive, depth-capped, child overrides parent.
- **Windows Gemini docs path** — global `GEMINI.md` now routes to `~/.agents/GEMINI.md` on Windows (mirroring the skill destination) instead of the POSIX-only `~/.gemini/GEMINI.md`, so the always-on guidance lands where Gemini CLI reads it.

## [0.7.0] - 2026-06-15

### Added
- **`--hook-status`** (#5, @muhajirdev) — a read-only command that reports whether
  agentmap's git-hook wiring is installed: the `post-commit` hook (and whether it's
  agentmap's vs a foreign hook), the `PreToolUse` nudge file, the `PreToolUse(Grep)`
  + `PreToolUse(Bash)` wiring in `.claude/settings.json`, and the `.gitignore` entry.
  Detection is a substring marker scan, so a **chained** `post-commit` (agentmap
  sharing one hook with another tool) is correctly reported as installed.
- **`--install-skill`** (#4, @muhajirdev) — install packaged agent-guidance assets so
  coding agents are steered to agentmap before falling back to grep: ships a Claude
  Code / Codex / OpenCode `SKILL.md` and a Cursor always-on rule. Flags:
  `--platform claude|cursor|agents|all` (default `all`), `--project` (default) or
  `--global`, and `--dry-run`. Writes are atomic and whitelisted to fixed,
  agentmap-namespaced paths. The installer is lazy-imported so it never loads on the
  warm `--any`/`--find` query hot path.

## [0.6.1] - 2026-06-14

### Fixed
- **Graceful degradation:** the per-file parse loop now wraps each file in
  try/catch — a single pathological source (e.g. a malformed import specifier
  that makes ts-morph throw) is skipped with a stderr warning instead of
  aborting the entire map build.
- **Path aliases for dynamic edges:** tsconfig/jsconfig `baseUrl`/`paths`
  aliases (`@/x`, `~/x`) now resolve for side-effect imports, dynamic
  `import()`, and `require()` too — previously only static imports formed edges.
- **Symbol ranking:** re-export barrels (`export { X } from './y'`) are no longer
  counted as references to `X`, so heavily re-exported symbols are not over-ranked
  in barrel-heavy repos (file-level dependency edges are unchanged).
- **Dirty-tree detection:** `git status` rename parsing is gated on the porcelain
  status code, so a plain file whose name contains `" -> "` is no longer
  mis-parsed (which could serve a stale cache as fresh).
- **`--map` tiny budgets:** partial-recovery now tests down to a single symbol,
  so a very small `--tokens` value still emits the top file instead of nothing.
- **Non-git fingerprint walk:** per-directory try/catch (a permission-denied
  subdir no longer empties the fingerprint and disables caching) plus a recursion
  depth cap; mirrored in the non-git Vue walk.

### Docs
- Clarified that the `--any` content fallback is case-insensitive by design
  (matches `--find`); matches are printed verbatim so true casing is visible.

## [0.6.0] - 2026-06-14

### Added
- **`--setup-mcp`** — configure agentmap as an MCP server for OpenCode and the Antigravity
  IDE (merge-safe write into each platform's MCP config; `--dry-run` previews without writing).
  Complements the existing `--mcp` stdio server so MCP-capable agents can query the map without
  a manual config edit.

## [0.5.0] - 2026-06-14

### Added
- **Vue SFC `<script>` indexing (#2).** `.vue` single-file components are now indexed:
  their `<script>` / `<script setup>` blocks are extracted (via a virtual TS/JS path) and
  participate in the import/symbol graph like any other source file, so `--relates`,
  `--find`, and the ranked map cover Vue components too. Best-effort — the template block is
  not parsed. Bumps the cache `SCHEMA_VERSION` (old caches rebuild automatically).

## [0.4.0] - 2026-06-14

### Added
- **Retrieval-accuracy eval (`eval/eval.mjs`, `npm run eval`, `EVAL.md`).** Scores whether
  agentmap returns the *correct* results, not just fewer tokens — complements the
  token-efficiency benchmark. Ground truth is derived live from real cloned repos (zod,
  zustand, hono) via an independent regex + import-resolver (not agentmap's own graph, so the
  comparison isn't circular), and scope is aligned both ways (test files and type-only edges
  excluded from both sides) so neither tool is unfairly scored. Measures symbol-definition
  top-1/top-3 hit rate and dependents precision/recall vs a naive `git grep` baseline.
  Network-only; excluded from CI. Clones land in gitignored `tmp/eval/`.

### Security
- **Untracked-secret exclusion in content search.** `--any` live content search
  no longer returns matches from untracked files such as a local `.env` — secrets
  that live only on disk (never committed) are excluded from results, so a query
  that happens to match a secret value surfaces the source-code match but never
  the credential file.
- **Post-commit hook hardening against local-script execution.** The git
  `post-commit` hook now trusts only the repo-root `./agentmap.mjs` (the unusual
  `./scripts/agentmap.mjs` path a malicious PR could add for arbitrary code
  execution on a victim's next commit was removed) and adds an
  `AGENTMAP_HOOK_NO_LOCAL=1` escape hatch to skip even `./agentmap.mjs` and rely
  solely on the installed binary / npx — for CI or when reviewing untrusted
  branches.

### Fixed
- **`--install-hooks` PreToolUse hook path now resolves under an npx install.**
  The nudge is copied into the project at `.claude/hooks/agentmap-nudge.mjs` and
  wired via `node "$CLAUDE_PROJECT_DIR/.claude/hooks/agentmap-nudge.mjs"`, instead
  of referencing `node_modules/@raymondchins/agentmap/...` which does not exist
  after an `npx` install (the hook silently never fired).
- **JSONC-tolerant settings parse.** `--install-hooks` now parses a project
  `.claude/settings.json` that contains comments (strict JSON first, then a
  comment-stripping retry) before surfacing a clear error.
- **Symlink-loop guard** in source enumeration / cache traversal.
- **Cache moved to `.claude/agentmap/`** (namespaced dir) with migration from the
  legacy single-file location; `.gitignore` now ignores `.claude/agentmap/`.
- **`--install-hooks --dry-run`** prints the files it would create/overwrite and
  writes nothing.

### Docs
- **Token-cost methodology disclosure** — benchmark numbers now state the
  `chars/4` token approximation and document the Scenario-F benchmark so readers
  can reproduce the before/after counts.
- **New `SECURITY.md`** — supported versions, private reporting channel, and the
  threat model for the post-commit hook + content search.

### CI
- Added security gates to `.github/workflows/ci.yml`: `npm audit`
  (`--audit-level=high`), CodeQL analysis, `npm pack --dry-run` manifest
  validation, and a Gitleaks secret scan.

### Chore
- Synced `package-lock.json` (it was stale at `0.2.0`).

## [0.3.0] - 2026-06-14

### Added
- **Bash-searcher coverage for the `PreToolUse` nudge hook.**
  `hooks/agentmap-nudge.mjs` previously only watched the `Grep` *tool*, so any
  search run as raw `grep`/`rg`/`egrep`/`fgrep`/`ag`/`ack` via the **Bash** tool
  bypassed the nudge entirely — the exact gap that let an agent forget agentmap
  and fall back to manual `Read`/`sed`/`awk`. The hook now also handles
  `tool_name === "Bash"` with an identical fire/silence heuristic, plus a new
  **multi-hump PascalCase symbol** rule (`ProviderCard`, `TopProviders`) that
  catches bare identifier hunts the Grep branch never sees. The Bash branch
  only fires when the searcher is the *primary* command (at the start of the
  string, or after `;`/`&&`) — piped filters like `ps aux | grep node` stay
  silent. The `--install-hooks` command now wires **both** a `Grep` and a
  `Bash` matcher into `.claude/settings.json` (idempotent, merge-safe).

- **New test file `test/nudge-hook.test.mjs`** (36 cases) drives the hook
  directly as a subprocess, covering Grep fires/silence, Bash fires/silence,
  PascalCase symbol detection, output shape validation, and injection safety.

### Changed
- `--install-hooks` now writes two `PreToolUse` entries — `matcher: "Grep"`
  and `matcher: "Bash"` — both pointing at the same `agentmap-nudge.mjs`. The
  hook dispatches internally on `tool_name`, so a single file covers both
  surfaces with no duplication of logic.
- The TS-generic denylist (`<Promise<`, `<Record<string`, `<Array<`, …) is no
  longer `^`-anchored — it now suppresses a generic wherever it appears. This
  fixes a spurious fire on the **Bash** branch (which tests the whole command,
  e.g. `rg "<Promise<Foo>"`) and on **mid-pattern** Grep generics
  (e.g. `useState<Promise>`). A `\b` after the type name keeps real components
  such as `<PromiseCard` / `<MapView` firing.

## [0.2.3] - 2026-06-14

### Changed
- **Docs only — no code change since 0.2.2.** README restructured to lead with the
  benchmark (now a before/after table of real per-task token counts: reading files vs
  agentmap) and the agent-loop differentiator, with plain-language section intros.
  CI actions bumped to v5 (Node 24). Published to sync the npm package page with the
  GitHub README.

## [0.2.2] - 2026-06-13

### Changed
- **`--install-hooks` now auto-wires the `PreToolUse(Grep)` nudge into the project's
  `.claude/settings.json`** (merge-safe + idempotent) instead of only printing the
  snippet — so the "agent is forced to use the map" enforcement is on by default
  after install, with no manual copy-paste step.

### Performance
- **Lazy-load `ts-morph`.** Its ~105 ms compiler init now fires only on a cold
  rebuild; warm cache queries (the common case on a clean tree) skip it entirely via
  `createRequire`, making them ~2× faster — measured **217 ms → 105 ms** median
  (−52%) on a clean-tree fixture. Cold-build time is unchanged.

## [0.2.1] - 2026-06-13

### Changed
- **License simplified to MIT-only.** Removed `LICENSE-APACHE` from the repo and
  the npm tarball. agentmap's PageRank / symbol ranking is an independent
  JavaScript reimplementation of a public algorithm (Aider calls `networkx`; no
  Aider source is copied), so it is not a derivative work and carries no
  Apache-2.0 obligation. Aider remains credited in `NOTICE` and the README as
  the origin of the ranking approach. Fixes GitHub showing an "Unknown" license.

## [0.2.0] - 2026-06-13

### Added
- **New CLI flags**: `--help` / `-h`, `--version` / `-v`, `--json` (global output modifier),
  `--install-hooks`, `--mcp` — full spec in README.
- **`--json` structured output** for all query commands (`--hubs`, `--features`, `--feature`,
  `--find`, `--relates`, `--map`, `--symbols`, `--any`, `--print`, bare build); enables
  machine-readable consumption by MCP clients and CI scripts.
- **MCP server** (`mcp.mjs`) — stdio MCP transport wrapping all query commands; launched via
  `agentmap --mcp` or directly. Ships in the npm tarball.
- **Hooks shipped in tarball** — `hooks/` directory (post-commit auto-refresh +
  `agentmap-nudge.mjs` PreToolUse hook for Claude Code) now listed in `package.json` `files`;
  installed into a repo via `agentmap --install-hooks`.
- **Apache-2.0 attribution** — `LICENSE-APACHE` and `NOTICE` added to credit Aider's
  PageRank / identifier-graph algorithm that agentmap ports.
- **Test suite** — `test/` directory with `node --test` runner; `npm test` entry point added
  to `package.json`.
- **CI** — GitHub Actions workflow running tests and a dry-run `npm pack` on every push.

### Fixed
- Corrected all npm-fetch references to use the scoped name `@raymondchins/agentmap`
  (the bare name `agentmap` on npm is an unrelated tool).
- Stale-cache robustness: cache invalidation now detects monorepo roots, path aliases,
  symlinked node_modules, spaces in paths, and large repos (>10 k files).
- `--print` JSON output now includes top-level `fileCount`.
- Unknown flags now print to stderr and exit 2 instead of silently rebuilding.
- Exit codes formalized: 0 = success, 1 = zero-result query, 2 = usage error.

### Changed
- Internal rename: entry file `repomap.mjs` → `agentmap.mjs`, cache file `.claude/repomap.json`
  → `.claude/agentmap.json`, and PreToolUse nudge hook `repomap-nudge.mjs` →
  `agentmap-nudge.mjs` — aligns all internal filenames with the published binary name.
- `package.json` `files` allowlist expanded from `["agentmap.mjs"]` to include `mcp.mjs`,
  `hooks/`, `LICENSE-APACHE`, and `NOTICE`.
- `.npmignore` removed — the `files` allowlist fully governs the tarball.

### Performance
- Faster cold builds: `skipFileDependencyResolution` plus `git ls-files`-based source
  enumeration (replacing an expensive full-tree FS glob) make a full build net faster
  than v0.1.0 while indexing the same-or-more files.

[Unreleased]: https://github.com/raymondchins/agentmap/compare/v0.12.1...HEAD
[0.12.1]: https://github.com/raymondchins/agentmap/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/raymondchins/agentmap/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/raymondchins/agentmap/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/raymondchins/agentmap/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/raymondchins/agentmap/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/raymondchins/agentmap/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/raymondchins/agentmap/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/raymondchins/agentmap/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/raymondchins/agentmap/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/raymondchins/agentmap/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/raymondchins/agentmap/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/raymondchins/agentmap/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/raymondchins/agentmap/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/raymondchins/agentmap/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/raymondchins/agentmap/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/raymondchins/agentmap/compare/v0.1.0...v0.2.0
