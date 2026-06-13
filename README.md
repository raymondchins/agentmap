<p align="center">
  <img src="assets/hero.png" alt="agentmap — ~98% token savings to understand a codebase (up to 99.9% per task)" width="100%">
</p>

# agentmap

**The repo map your coding agent is _forced_ to use — ~98% fewer tokens to understand your TS/JS codebase.**

A queryable, ranked code-relationship map for TypeScript/JavaScript repos that answers
"understand the codebase" questions in **~98% fewer tokens on average** (up to **99.9%
per task**) vs reading raw files. Personalized PageRank importance, Aider-style symbol
ranking, a token-budgeted digest, and a single `--any` router (file → symbol → feature →
live git-grep) — wired straight into the agent loop so it actually gets used, not just
published.

[![npm](https://img.shields.io/npm/v/@raymondchins/agentmap)](https://www.npmjs.com/package/@raymondchins/agentmap)
[![CI](https://github.com/raymondchins/agentmap/actions/workflows/ci.yml/badge.svg)](https://github.com/raymondchins/agentmap/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](#)

> One file, one runtime dependency (`ts-morph`, which bundles the TypeScript compiler — ~10 MB installed). No vector DB, no embedding API, no server.
> `npx @raymondchins/agentmap --any <query>` and you have a ranked answer.

---

## Why it's different

Most "repo context" tools are one-shot: they pack the repository (or a slice of it) into a
prompt and stop there. agentmap is a **queryable, ranked, and self-refreshing** map that an
agent can interrogate flag-by-flag — and, crucially, is **wired into the agent loop** via a
post-commit auto-refresh and a `PreToolUse` hook that nudges the agent to use the map
*before* it falls back to serial grep.

| | **agentmap** | Aider repo map | RepoMapper | Repomix | code2prompt |
| --- | --- | --- | --- | --- | --- |
| **Ranking algorithm** | Personalized PageRank (file + symbol graphs) | PageRank (graph ranking) | Importance heuristics | None (file order) | None (file order) |
| **Languages** | TS/JS (via ts-morph) | Many (tree-sitter) | Many (tree-sitter) | Language-agnostic (text) | Language-agnostic (text) |
| **Token-budget output** | Yes — `--map [--tokens N]` ranked digest | Yes (built into Aider's context) | Partial | Yes (size caps) | Yes (templates/caps) |
| **Agent-loop integration** | **Yes — post-commit auto-refresh + PreToolUse hook** | In-process (Aider only) | No | No | No |
| **Dependencies** | `ts-morph` only | Python + tree-sitter stack | Python + tree-sitter | Node | Rust binary |
| **Install** | `npx @raymondchins/agentmap` | `pip install aider` | `pip install` | `npx`/global | `cargo`/binary |

What that table is **not** claiming: agentmap is TS/JS-only (the others are multi-language),
and it's a **file-level import graph**, not a full call-site/reference resolver (see
[Scope & limitations](#scope--limitations)). The differentiators are narrow and honest:
**(1)** the `--any` router, and **(2)** the agent-loop wiring. Everything else is table stakes.

---

## Quickstart

No install needed:

```bash
npx @raymondchins/agentmap --any <query>
```

…or run it directly from a checkout:

```bash
node agentmap.mjs --any <query>
```

The first run builds and caches the map to `.claude/agentmap.json` (add it to
`.gitignore`). Subsequent runs serve the cache when the tree is clean and `HEAD` is
unchanged, and silently rebuild from disk when there are uncommitted `.ts/.tsx/.js/...`
edits — so queries always reflect your in-flight work.

Run with no flag to build + print a one-line summary:

```
$ node agentmap.mjs
agentmap: 154 files | 4 features | top hub: lib/utils.ts (deg 52, pr 0.105171)
```

---

## The `--any` router

One flag, no flag-picking. `--any <query>` resolves your query through a cascade and
returns the first layer that hits:

```
--any <query>
   │
   ├─ 1. FILE     exact path → unique basename → unique substring
   ├─ 2. SYMBOL   exported name contains the query (across all files)
   ├─ 3. FEATURE  app/-router feature name contains the query
   └─ 4. CONTENT  live `git grep` (tracked + untracked) — never stale
```

Layers 1–3 read the cached structural map (fast, ranked). Layer 4 is a **live disk read**
via `git grep -F`, so raw strings, copy, Tailwind classes, and config values the structural
graph never indexes still resolve instead of coming up empty.

**Symbol hit** (query resolved to a symbol → full block):

```
$ node agentmap.mjs --any cn
[structure] 1 symbol, 0 feature match for "cn"
  lib/utils.ts → cn (FunctionDeclaration)
```

**Ambiguous file hit** (query matched multiple files → narrow it):

```
$ node agentmap.mjs --any utils
[structure] "utils" matched 3 files — narrow it:
  lib/utils.ts
  lib/db/utils.ts
  tests/prompts/utils.ts
```

**Content fallback** (no file/symbol/feature match → live git-grep):

```
$ node agentmap.mjs --any streamText
[content] 13 lines:
app/(chat)/api/chat/route.ts:8:  streamText,
app/(chat)/api/chat/route.ts:194:        const result = streamText({
artifacts/code/server.ts:1:import { streamText } from "ai";
artifacts/code/server.ts:18:    const { fullStream } = streamText({
artifacts/code/server.ts:40:    const { fullStream } = streamText({
artifacts/sheet/server.ts:1:import { streamText } from "ai";
artifacts/sheet/server.ts:11:    const { fullStream } = streamText({
```

---

## Commands

Every snippet below is **representative output** (long lists trimmed) from running agentmap against the public
154-file Next.js repo [vercel/ai-chatbot](https://github.com/vercel/ai-chatbot) (sha 2becdb4).

### `--any <q>` — the router (file → symbol → feature → live content)

See [The `--any` router](#the---any-router) above. Default first move for any
"where/what/who" question.

### `--find <q>` — reuse-before-rebuild symbol search

Find every exported symbol whose name contains the query. Use it before writing a new util
or component to check what already exists.

```
$ node agentmap.mjs --find Message
find "Message": 55 match
  hooks/use-messages.tsx → useMessages (FunctionDeclaration)
  lib/errors.ts → getMessageByErrorCode (FunctionDeclaration)
  lib/types.ts → messageMetadataSchema (VariableDeclaration)
  lib/types.ts → MessageMetadata (TypeAliasDeclaration)
  lib/types.ts → ChatMessage (TypeAliasDeclaration)
  lib/utils.ts → convertToUIMessages (FunctionDeclaration)
  lib/utils.ts → getTextFromMessage (FunctionDeclaration)
  tests/helpers.ts → generateTestMessage (FunctionDeclaration)
  app/(chat)/actions.ts → generateTitleFromUserMessage (FunctionDeclaration)
  …
```

### `--relates <path>` — blast radius + transitive relevance

The file's own block (exports / imports / direct dependents) **plus** a random-walk
relevance list (personalized PageRank on the bidirectional import graph) — the files most
related to the target, transitively, not just its direct importers.

```
$ node agentmap.mjs --relates lib/db/schema.ts
relates: lib/db/schema.ts  (pr 0.073744)
exports (14): user(VariableDeclaration), User(TypeAliasDeclaration), chat(VariableDeclaration), Chat(TypeAliasDeclaration), message(VariableDeclaration), DBMessage(TypeAliasDeclaration), …
imports (0): —
dependents (21): hooks/use-active-chat.tsx, lib/types.ts, lib/utils.ts, components/chat/artifact.tsx, components/chat/message.tsx, lib/db/queries.ts, app/(chat)/api/chat/route.ts, …
related (random-walk relevance):
  lib/utils.ts (0.0476)
  lib/types.ts (0.0376)
  components/chat/artifact.tsx (0.0372)
  components/chat/icons.tsx (0.0264)
  components/chat/message.tsx (0.0237)
  lib/db/queries.ts (0.0225)
  app/(chat)/api/chat/route.ts (0.0218)
  …
```

### `--feature <name>` — files that make up a feature

Resolves a Next.js `app/`-router feature to its file set, plus the external files that
depend on it.

```
$ node agentmap.mjs --feature api
feature "api": 11 files
  app/(chat)/api/chat/route.ts
  app/(chat)/api/chat/schema.ts
  app/(chat)/api/document/route.ts
  app/(chat)/api/history/route.ts
  app/(chat)/api/messages/route.ts
  app/(chat)/api/models/route.ts
  app/(chat)/api/suggestions/route.ts
  app/(chat)/api/vote/route.ts
  app/(auth)/api/auth/guest/route.ts
  app/(chat)/api/files/upload/route.ts
  app/(chat)/api/chat/[id]/stream/route.ts
external dependents (0): —
```

### `--features` — list features by size

```
$ node agentmap.mjs --features
features (4):
  api (11 files)
  login (1 files)
  register (1 files)
  chat (1 files)
```

### `--hubs` — most important files (PageRank)

The files that matter most, ranked by PageRank importance (raw dependent degree shown
alongside).

```
$ node agentmap.mjs --hubs
agentmap: 154 files (sha 2becdb4)
hubs (PageRank importance):
  lib/utils.ts (deg 52, pr 0.105171)
  lib/db/schema.ts (deg 21, pr 0.073744)
  lib/types.ts (deg 23, pr 0.067589)
  components/chat/artifact.tsx (deg 15, pr 0.036882)
  components/chat/icons.tsx (deg 27, pr 0.035378)
  lib/errors.ts (deg 9, pr 0.032787)
  lib/db/queries.ts (deg 14, pr 0.030085)
  …
```

### `--symbols [N]` — top ranked symbols (Aider-style)

The most important individual symbols across the repo, ranked by the identifier graph
(defaults to 30).

```
$ node agentmap.mjs --symbols 10
top 10 ranked symbols (Aider-style):
  0.109902  lib/utils.ts → cn (FunctionDeclaration)
  0.036013  lib/types.ts → ChatMessage (TypeAliasDeclaration)
  0.025686  components/chat/artifact.tsx → ArtifactKind (TypeAliasDeclaration)
  0.022461  lib/errors.ts → ChatbotError (ClassDeclaration)
  0.021068  lib/types.ts → CustomUIDataTypes (TypeAliasDeclaration)
  0.020872  lib/db/schema.ts → Document (TypeAliasDeclaration)
  0.020555  components/ai-elements/suggestion.tsx → Suggestion (VariableDeclaration)
  0.020555  lib/db/schema.ts → Suggestion (TypeAliasDeclaration)
  0.018124  lib/db/schema.ts → DBMessage (TypeAliasDeclaration)
  0.015034  lib/errors.ts → ErrorCode (TypeAliasDeclaration)
```

### `--map [--tokens N] [--focus <path>]` — token-budgeted ranked digest

The token-budgeted digest (Aider's killer feature): a ranked, files-and-symbols summary
that fits a token budget. Default budget is 8192 (1024 with `--focus`). `--focus <path>`
personalizes the ranking toward a file you're working on.

```
$ node agentmap.mjs --map --tokens 400
# agentmap (154 files, sha 2becdb4) — focus: global, budget ~400 tok

lib/utils.ts:
  cn (FunctionDeclaration)
  generateUUID (FunctionDeclaration)

lib/types.ts:
  ChatMessage (TypeAliasDeclaration)
  CustomUIDataTypes (TypeAliasDeclaration)
  ChatTools (TypeAliasDeclaration)
  Attachment (TypeAliasDeclaration)

components/chat/artifact.tsx:
  ArtifactKind (TypeAliasDeclaration)
  UIArtifact (TypeAliasDeclaration)
  Artifact (VariableDeclaration)

lib/errors.ts:
  ChatbotError (ClassDeclaration)
  ErrorCode (TypeAliasDeclaration)

lib/db/schema.ts:
  Document (TypeAliasDeclaration)
  Suggestion (TypeAliasDeclaration)
  DBMessage (TypeAliasDeclaration)

# ~387 tokens (14 files shown)
```

Focused on a working file — the ranking re-centers on what `lib/db/queries.ts` actually touches:

```
$ node agentmap.mjs --map --focus lib/db/queries.ts --tokens 350
# agentmap (154 files, sha 2becdb4) — focus: lib/db/queries.ts, budget ~350 tok

lib/utils.ts:
  cn (FunctionDeclaration)
  generateUUID (FunctionDeclaration)
  getDocumentTimestampByIndex (FunctionDeclaration)
  fetcher (VariableDeclaration)
  getTextFromMessage (FunctionDeclaration)
  convertToUIMessages (FunctionDeclaration)
  fetchWithErrorHandlers (FunctionDeclaration)
  sanitizeText (FunctionDeclaration)

lib/db/schema.ts:
  DBMessage (TypeAliasDeclaration)
  Suggestion (TypeAliasDeclaration)
  Document (TypeAliasDeclaration)
  Chat (TypeAliasDeclaration)
  User (TypeAliasDeclaration)
  chat (VariableDeclaration)
  document (VariableDeclaration)
  message (VariableDeclaration)

lib/errors.ts:
  ChatbotError (ClassDeclaration)
  ErrorCode (TypeAliasDeclaration)

# ~324 tokens (8 files shown)
```

### `--print` — full map as JSON

Dumps the cached map (`hubs`, `features`, `rankedSymbols`, `files`) as one JSON object —
for piping into other tools. Also includes a top-level `fileCount`.

```
$ node agentmap.mjs --print | jq '.hubs[0]'
"lib/utils.ts (deg 52, pr 0.105171)"
```

### Global flags

| Flag | Description |
|------|-------------|
| `--help` / `-h` | Print a usage block listing every flag and exit 0. |
| `--version` / `-v` | Print the version from `package.json` and exit 0. |
| `--json` | **Global modifier.** When present, every command prints exactly one JSON object to stdout (no prose). Shapes vary per command: `--json --hubs` → `{command,fileCount,sha,hubs:[string]}`, `--json --find X` → `{command,query,matches:[{file,name,kind}]}`, `--json --relates X` → `{command,file,pagerank,exports,imports,dependents,related}`, `--json --any X` → `{command,query,kind,…payload}`, etc. Bare `--json` (no query flag) → `{command:"build",fileCount,features,topHub}`. |
| `--install-hooks` | Copy `hooks/post-commit` into `.git/hooks/` (chmod 0755), ensure `.claude/agentmap.json` is in `.gitignore`, and print the Claude Code `settings.json` `PreToolUse` snippet. Exit 0 on success, stderr + exit 1 on failure. |
| `--mcp` | Start agentmap as a **stdio MCP server** so non-Claude-Code agents (Cursor, Cline, any MCP client) can call every flag as a first-class tool. |

**Exit-code contract:** `0` = success / match / help / version; `1` = query returned zero results (`--any`, `--find`, `--relates`, `--feature` with no match); `2` = usage error (missing required arg, unknown flag). Any token starting with `-` that matches no known flag prints an error to stderr and exits 2.

---

## The agent loop (the actual point)

A repo map only helps if the agent uses it. agentmap ships two hooks (in [`./hooks/`](./hooks/))
that close the loop: the map refreshes itself after every commit, and the agent gets nudged
to query the map before it serial-greps.

### 1. Auto-refresh on commit

[`hooks/post-commit`](./hooks/post-commit) rebuilds `.claude/agentmap.json` after each
commit, detached + silenced so it never slows the commit. It skips during
rebase/merge/cherry-pick and no-ops if Node is missing.

The hooks ship inside the npm package. The simplest setup:

```bash
npx @raymondchins/agentmap --install-hooks
```

This copies `hooks/post-commit` into `.git/hooks/`, sets it executable, ensures
`.claude/agentmap.json` is in `.gitignore`, and prints the `.claude/settings.json`
snippet for the `PreToolUse` nudge hook (below). Manual alternative:

```bash
# from your repo root
cp hooks/post-commit .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

The hook auto-locates the builder: a local `agentmap.mjs`, then `scripts/agentmap.mjs`, then
the installed `agentmap` binary, then `npx --no-install @raymondchins/agentmap`.

### 2. Force the agent to use it — `PreToolUse` hook

[`hooks/agentmap-nudge.mjs`](./hooks/agentmap-nudge.mjs) is a **non-blocking** `PreToolUse(Grep)`
hook for Claude Code. When a `Grep` looks like a dependency / who-imports / component-usage /
reuse search, it injects a reminder steering the agent to `agentmap --any` first. It never
denies the grep, and stays silent for raw-string / Tailwind-class / lowercase-HTML-tag
sweeps — so it's high-signal, not nagging.

Wire it up in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Grep",
        "hooks": [
          { "type": "command", "command": "node ./hooks/agentmap-nudge.mjs" }
        ]
      }
    ]
  }
}
```

That's the "forced to use it" in the tagline: the map stays current on its own, and the
agent is steered to it the moment it reaches for a dependency-shaped grep.

---

## Scope & limitations

Honesty first — this is deliberately a small, sharp tool, not a universal code-graph.

- **TS/JS only, by design.** Built on `ts-morph`. No Python, Go, Rust, etc. If your repo
  isn't TypeScript/JavaScript, use a tree-sitter-based tool instead. Support for other
  languages is a possible future direction.
- **File-level import graph, not a full reference graph.** Edges come from static
  `import` / re-export declarations and the named symbols crossing them. It does **not**
  do call-site or full reference resolution — `--relates` tells you which files import a
  module, not every line that calls a given function.
- **PageRank + symbol ranking are real and implemented** (damping 0.85, deterministic
  power iteration; personalized variants for `--relates` and `--map --focus`). The symbol
  ranking is a faithful port of Aider's identifier-graph approach (credit:
  [Aider](https://github.com/Aider-AI/aider), Apache-2.0).
- **Feature detection assumes the Next.js `app/` router.** `--feature` / `--features`
  derive features from the first real route segment under `app/` (or `src/app/`), skipping
  route groups `(...)`, dynamic `[...]`, and parallel `@...` segments. Repos without an
  `app/` directory simply report zero features — every other command still works.
- **Token counts are estimates** (`chars / 4`), not a real BPE tokenizer. Treat
  `--map`/`--tokens` budgets as approximate (±10%).
- The PreToolUse hook is **Claude Code-specific** (it speaks Claude Code's hook JSON). The
  post-commit hook is generic git.

---

## Benchmark

Measured across **7 agent tasks on 3 real public repos** — reproducible with `node benchmark/bench.mjs <repo>`:

| Repo | Files | Tokens saved |
|------|------:|-------------:|
| [vercel/ai-chatbot](https://github.com/vercel/ai-chatbot) | 154 | **98.3%** |
| [colinhacks/zod](https://github.com/colinhacks/zod) | 367 | **99.2%** |
| [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy) | 125 | **96.0%** |

Per-task peaks (real, across the three repos): **whole-repo map 99.8%**, **reuse-before-rebuild lookup 99.9%**, **blast-radius 99.2%**, **find-symbol 99%**. Cold build (parse + PageRank + symbol graph) **~1.2s**; warm cached query **~0.2s**.

Honest notes: the win scales with repo size — a *trivial single-file* `--any` lookup can actually cost **more** than `cat`+`grep` (taxonomy showed −313% on that one task; we leave it in). Numbers measure **context-token volume**, not end-to-end retrieval accuracy. Token est = `chars / 4`, applied to both sides.

Full methodology, per-repo tables, and all caveats: **[`./benchmark/RESULTS.md`](./benchmark/RESULTS.md)**.

---

## Contributing

Issues and PRs welcome. High-value directions:

- An end-to-end retrieval/accuracy eval (the benchmark is context-efficiency only today).
- A real tokenizer behind the `--map` budget.
- Hardening feature detection for non-`app/`-router layouts.

Keep the dependency footprint minimal — `ts-morph` is the only runtime dependency (it bundles
the TypeScript compiler, ~10 MB installed), and keeping it that way is a feature.

## License

[MIT](./LICENSE). Symbol-ranking algorithm credit: [Aider](https://github.com/Aider-AI/aider) (Apache-2.0).
