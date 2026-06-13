# Contributing to agentmap

Thanks for your interest. agentmap is intentionally small. Before opening a PR,
please read the scope and invariants below — changes that break them will be
declined regardless of how useful they are in isolation.

## Scope

agentmap is a **TypeScript/JavaScript-first** code-relationship map built on
[`ts-morph`](https://github.com/dsherret/ts-morph). It parses a repo, derives a
file-level import graph from named/default/namespace imports and re-export
barrels, ranks files (PageRank) and symbols (Aider-style identifier graph), and
exposes a single `--any` router plus a token-budgeted `--map` digest.

Contributions that fit the scope:

- Bug fixes in the existing parsing / ranking / CLI behavior.
- Better handling of TS/JS module-graph edge cases (path aliases, barrels,
  dynamic-but-statically-analyzable imports).
- Sharper `--any` routing, `--map` budgeting, or output ergonomics.
- Docs, examples, and tests.

Out of scope (will be declined):

- New language backends (Python, Go, Rust, etc.). agentmap is TS/JS-first by
  design; a polyglot rewrite is a different project.
- Full reference/call-site resolution. The graph is deliberately
  **import-edge-derived**, not a whole-program reference scan — that is what
  keeps it fast and dependency-light. Don't replace it with a heavyweight
  type-checker walk.

## Near-zero-deps rule

**agentmap ships with exactly one runtime dependency: `ts-morph`.**

PRs that add runtime dependencies will be rejected by default. This is a hard
rule, not a preference:

- No utility/lodash-style libraries — write the helper inline.
- No heavy AST/graph/CLI frameworks. PageRank, the identifier graph, the CLI
  arg parser, and the token estimator are all hand-rolled on purpose.
- No native/C-binding dependencies (they fail silently in serverless/agent
  sandboxes and bloat install time).

If you believe a new dependency is genuinely unavoidable, open an issue first
and make the case before writing code. "It's only a few KB" is not the bar —
the bar is "this cannot reasonably be done inline and `ts-morph` doesn't already
provide it."

## How to run it

```bash
# install the single dependency
npm install

# build + write .claude/agentmap.json for the current repo
node agentmap.mjs
# or
npm run map

# query without rebuilding (served from cache when fresh — see invariant below)
node agentmap.mjs --hubs                 # PageRank-ranked hub files
node agentmap.mjs --symbols 30           # Aider-style ranked symbols
node agentmap.mjs --map --tokens 4096    # token-budgeted ranked digest
node agentmap.mjs --map --focus lib/foo.ts
node agentmap.mjs --any PremiumCard      # router: file → symbol → feature → git grep
node agentmap.mjs --find useAuth         # exported-symbol search
node agentmap.mjs --relates lib/foo.ts   # blast radius + random-walk relevance
node agentmap.mjs --feature dashboard    # files in a Next.js app/ feature
node agentmap.mjs --features             # list features
node agentmap.mjs --print                # raw JSON
```

agentmap runs in the **target repo's** working directory and expects a
`tsconfig.json` there (it also pulls in top-level and `scripts/**` `.mjs/.cjs/.js`
files that `tsconfig.include` typically omits).

## The freshness invariant (do NOT break this)

agentmap's contract with the agent loop is that **a query never returns a stale
map**. The cache at `.claude/agentmap.json` is served **only when it is provably
current**, which means ALL of:

1. `cached.generatedSha === git rev-parse --short HEAD` (map was built at the
   current commit), AND
2. `cached.schema === SCHEMA_VERSION` (no schema drift), AND
3. the working tree is **clean** for TS/JS files (`git status --porcelain` shows
   zero `.ts/.tsx/.mjs/.cjs/.jsx/.js` changes).

If any condition fails, `ensureFresh()` **rebuilds from disk** so the result
reflects in-flight edits. This is what makes agentmap safe to wire into a
`PreToolUse` hook and a post-commit auto-refresh.

When you touch caching, building, or the schema:

- **Bump `SCHEMA_VERSION`** whenever the shape of `agentmap.json` changes, so old
  caches are invalidated instead of mis-read.
- **Never** serve the cache on a dirty tree or a mismatched SHA. Don't add a
  "skip the freshness check for speed" flag — staleness is the one failure mode
  this tool exists to prevent.
- Keep the live `--any` git-grep fallback reading from **disk** (tracked +
  untracked), never from the cached graph, so copy/string-literal lookups are
  always current.

## Style

- Plain ES modules, Node 18+, no build step. The published artifact is the
  single `agentmap.mjs` file (keep the `#!/usr/bin/env node` shebang at the top).
- Determinism matters: ranking must not depend on a PRNG or unstable iteration
  order. PageRank uses a fixed node order and converges by tolerance.
- Prefer small, commented, hand-rolled helpers over pulling in a dependency.
