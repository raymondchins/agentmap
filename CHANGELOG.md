# Changelog

All notable changes to agentmap are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

[Unreleased]: https://github.com/raymondchins/agentmap/compare/v0.1.0...HEAD
