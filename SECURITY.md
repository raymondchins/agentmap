# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | Yes       |
| < 0.3   | No        |

Only the latest `0.3.x` release receives security fixes. Upgrade before reporting.

---

## Reporting a Vulnerability

**Preferred:** Use [GitHub private vulnerability reporting](https://github.com/raymondchins/agentmap/security/advisories/new) — it keeps the report confidential until a fix ships.

**Fallback:** Email raymondchin.s@gmail.com with subject `[agentmap security]`. Include steps to reproduce, impact assessment, and any suggested fix if you have one.

**Response target:** ~72 hours for an initial acknowledgment. This is a solo-maintained project; patch timelines depend on severity. Critical issues will be prioritized.

Please do not open a public GitHub issue for a security vulnerability before a fix is available.

---

## Security Notes / Threat Model

agentmap is a local developer tool. It reads your repository's TypeScript/JavaScript source tree and writes a few config files. There is no network server, no remote telemetry, and no credentials storage.

### What agentmap installs (`--install-hooks`)

Running `--install-hooks` modifies three things on the local machine:

| File modified | What it does |
|---|---|
| `.git/hooks/post-commit` | Appends a line that runs `agentmap --refresh` after every commit to keep the map current |
| `.gitignore` | Appends entries to exclude agentmap's cache files (`agentmap.json`, `agentmap-cache/`) from version control |
| `.claude/settings.json` | Appends a `PreToolUse(Grep)` hook that nudges Claude Code to query agentmap before running a raw grep |

Preview what will change before committing: `npx @raymondchins/agentmap --install-hooks --dry-run`

The post-commit hook is a single-line shell command that only invokes agentmap's own binary — it does not source or execute any repo-local scripts. Repos can opt out of the hook running locally by setting the environment variable `AGENTMAP_HOOK_NO_LOCAL=1`.

### File access during content search (`--any`)

When no graph match is found, agentmap falls back to a live `git grep` over tracked files and may also scan untracked files in the working tree. The following files are excluded from content search by pattern:

- `.env`, `.env.*`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- Files matching `*secret*`, `*credential*`, `*password*`, `*token*`

agentmap does **not** transmit file contents anywhere — all processing is local.

### Trust boundaries

| Boundary | Notes |
|---|---|
| agentmap binary | Trusted — installed from npm, same as any devDependency |
| Post-commit hook | Executes as the committing user; only runs agentmap itself, not arbitrary repo scripts |
| `PreToolUse` hook in `.claude/settings.json` | Executes inside Claude Code's hook runner as the Claude Code process user |
| Repository source files | Read-only; sensitive file patterns excluded from content search (see above) |
| agentmap cache (`agentmap.json`) | Stores file paths, import edges, and symbol names from your codebase — no secrets — but is gitignored by default |

### Out of scope

- Vulnerabilities in `ts-morph` / the bundled TypeScript compiler (report upstream to [microsoft/TypeScript](https://github.com/microsoft/TypeScript/security))
- Issues requiring physical access to the developer's machine
- Theoretical attacks that require the attacker to already have write access to the repository
