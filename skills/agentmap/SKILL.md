---
name: agentmap
description: >-
  Use for TypeScript/JavaScript codebase navigation — symbol lookup, blast radius,
  reuse checks, and repo orientation. Prefer agentmap before serial grep when
  exploring imports, exports, or where a symbol lives. Package is
  @raymondchins/agentmap (not the unrelated npm package agentmap).
---

# agentmap

Queryable, ranked **import graph** for TS/JS repos (PageRank hubs, symbol ranking, token-budgeted digest). Faster and more accurate than grep for structural questions.

## When to use

- **Where is X defined?** / **who imports this file?** / **what breaks if I edit this?**
- **Reuse check** before adding a util, component, or type
- **Session start** — orient to a large monorepo cheaply

## When not to use

- Raw string / config value search (try `agentmap --any` first — layer 4 is live `git grep`)
- Non-TS/JS files, runtime call graphs, or full semantic "how does it work?" (use codebase search)
- Next-style `--feature` on TanStack Router / non-`app/` layouts (often empty)

## Commands (run in repo root)

```bash
# Smart router — default first move
agentmap --any <query>

# Reuse / symbol definition
agentmap --find <SymbolName>

# Blast radius (exports, imports, dependents, related files)
agentmap --relates <path/to/file.ts>

# Token-budgeted ranked digest
agentmap --map --tokens 400
agentmap --map --focus <path> --tokens 400

# Hub files (PageRank)
agentmap --hubs

# JSON for tools
agentmap --json --any <query>
```

Install: `npm i -g @raymondchins/agentmap` or `npx @raymondchins/agentmap`. Map cache: `.claude/agentmap/` (gitignored).

## Agent platforms

| Platform | Setup |
|----------|--------|
| **Claude Code** | `agentmap --install-hooks` (post-commit refresh + PreToolUse grep nudge) |
| **Cursor / MCP clients** | `agentmap --mcp` in MCP config, or Shell + commands above |
| **This skill** | `agentmap --install-skill` |

## Workflow

1. If the map may be stale after edits, run `agentmap` (no flags) or rely on post-commit hook.
2. Start with `agentmap --any <symbol or topic>`.
3. Before editing a hub file, run `agentmap --relates <that-file>`.
4. Fall back to grep only when agentmap returns no useful structure hit.

## Package name

```bash
npx @raymondchins/agentmap --any Procedure
# NOT: npm install agentmap  (different package)
```
