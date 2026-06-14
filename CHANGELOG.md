# Changelog

All notable changes to agentmap are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

[Unreleased]: https://github.com/raymondchins/agentmap/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/raymondchins/agentmap/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/raymondchins/agentmap/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/raymondchins/agentmap/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/raymondchins/agentmap/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/raymondchins/agentmap/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/raymondchins/agentmap/compare/v0.1.0...v0.2.0
