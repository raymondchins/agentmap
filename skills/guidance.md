## agentmap (repo map)

This project can use **agentmap** (`@raymondchins/agentmap`) — a queryable import/symbol map at `.claude/agentmap/`.

**Before Grep/Glob for structural questions** (where is a symbol, who imports a file, reuse check, blast radius), prefer:

```bash
agentmap --any <query>          # file → symbol → feature → git-grep fallback
agentmap --find <Symbol>        # exported symbols matching name
agentmap --relates <file.ts>    # imports, dependents, related files
agentmap --map --tokens 400     # cheap repo orientation
```

Use Read/Grep directly when:

1. agentmap already oriented you and you need exact lines to edit
2. The map is missing — run `agentmap` once to build `.claude/agentmap/`
3. Searching raw strings, logs, or non-TS files

**MCP (optional):** `agentmap --mcp` exposes the same queries as tools.

**Note:** `--features` only detects Next.js `app/` routes; TanStack `src/routes/` repos often show `features (0)`.

Package: `@raymondchins/agentmap` — not the unrelated PyPI/npm `agentmap` package.
