# Security Policy

## Supported Versions

| Version  | Supported |
|----------|-----------|
| 0.14.x   | Yes       |
| < 0.14   | No        |

Only the latest `0.14.x` release receives security fixes. Upgrade before reporting.

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
| `.git/hooks/post-commit` | Installs a hook that rebuilds the map after every commit to keep it current |
| `.gitignore` | Appends an entry to exclude agentmap's cache directory (`.claude/agentmap/`) from version control |
| `.claude/settings.json` | Appends a `PreToolUse(Grep)` hook that nudges Claude Code to query agentmap before running a raw grep |

Preview what will change before committing: `npx @raymondchins/agentmap --install-hooks --dry-run`

By default the post-commit hook invokes only the **installed** agentmap package — the repo's `node_modules/.bin/agentmap`, a PATH binary verified to resolve to `@raymondchins/agentmap`, or `npx @raymondchins/agentmap`. It does **not** execute a repo-local `./agentmap.mjs` unless you explicitly opt in with `AGENTMAP_HOOK_ALLOW_LOCAL=1` (intended only for developing agentmap itself), so an attacker-planted `agentmap.mjs` in a checked-out branch cannot run on your next commit.

### File access during content search (`--any`)

When no graph match is found, agentmap falls back to a live `git grep` over tracked files and may also scan untracked files in the working tree. The following files are excluded from content search by pattern (case-insensitive name matches):

- `.env`, `.env.*`, `*.env` (at any depth)
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `*.p8`, `*.jks`, `*.keystore`
- SSH private keys: `id_rsa*`, `id_ed25519*`, `id_ecdsa*`
- Credential dotfiles (root or any depth): `.npmrc`, `.netrc`, `.git-credentials`, `.pgpass`, `.htpasswd`, `.pypirc`
- Files whose name contains `secret`, `credential`, or `password`

This denylist is a best-effort guard for conventionally-named secret files, not a guarantee — a secret stored in an unmatched filename can still be surfaced. (It deliberately does **not** match a bare `token` substring, which would over-exclude ordinary source like `tokenizer.ts`.) agentmap does **not** transmit file contents anywhere; all processing is local.

### Trust boundaries

| Boundary | Notes |
|---|---|
| agentmap binary | Trusted — installed from npm, same as any devDependency |
| Post-commit hook | Executes as the committing user; runs the installed agentmap package only, never a repo-local script unless `AGENTMAP_HOOK_ALLOW_LOCAL=1` is set |
| `PreToolUse` hook in `.claude/settings.json` | Executes inside Claude Code's hook runner as the Claude Code process user |
| Repository source files | Read-only; sensitive file patterns excluded from content search (see above) |
| agentmap cache (`.claude/agentmap/map.json`) | Stores file paths, import edges, and symbol names from your codebase — no secrets — but is gitignored by default |

### Out of scope

- Vulnerabilities in `ts-morph` / the bundled TypeScript compiler (report upstream to [microsoft/TypeScript](https://github.com/microsoft/TypeScript/security))
- Issues requiring physical access to the developer's machine
- Theoretical attacks that require the attacker to already have write access to the repository
