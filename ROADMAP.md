# agentmap — Improvement Roadmap

> Working plan derived from a full multi-agent audit (2026-07-03): 7 code-audit
> dimensions + 3 web-research reports, every finding adversarially verified.
> This doc is the pick-up-anywhere backlog — each task carries a `file:line`
> anchor, the fix approach, and a checkbox. Check items off as you land them.
>
> **How to use:** work the batches top-to-bottom (they're ordered by
> effort-vs-impact and dependency). Batch 2 is the structural enabler for 3 and
> 5 — do it before them. Within a batch, land one commit per logical fix with a
> regression test, and keep `npm test` green (**396 tests** as of 2026-07-26).
>
> **[Part II](#part-ii--make-it-useful-for-the-majority-2026-07-26) (2026-07-26)**
> is a second audit pass answering "make this useful for the majority of people —
> multi-language?". It supersedes the *Strategic decision* section below and the
> deferred tree-sitter item in Batch 5. Start there; Batches 1–B remain the
> engineering backlog.

---

## Strategic decision: multi-language support

> ⚠️ **SUPERSEDED 2026-07-26 by [Part II](#part-ii--make-it-useful-for-the-majority-2026-07-26).**
> The verdict below ("build the seam now, defer the languages") survives, but its
> reasoning does not: the gate it set could never fire (there was no working
> distribution to generate demand — every npm install path exited 0 printing
> nothing from 0.10.0 to 0.16.0), the seam it claims to have bought was not
> actually built, and four of its supporting claims are stale or refuted. Read
> Part II §1 before acting on anything in this section.

**Question raised:** should agentmap move beyond TS/JS (adopt Python/Go/Rust…)?

**Answer: build the seam now, defer the languages.** The two research reports
deliberately disagreed, and the reconciliation is:

- **Competitive report:** multi-language via tree-sitter is the kill-zone of
  **CodeGraph** (launched Jan 2026, ~57k stars at the time — 62,450 and 35 languages
  as of 2026-07-26, see Part II §1 — 2s auto-sync,
  auto-configures 8 agent CLIs). Entering it = being the 4th-best polyglot. What
  CodeGraph/Serena *can't* match is agentmap's compiler-grade ts-morph accuracy
  (tree-sitter rivals are demonstrably noisy on call graphs), personalized
  PageRank, and honest eval methodology.
- **Technical report:** IF adopted, the proven pattern is `web-tree-sitter`
  (WASM, zero native deps) + Aider-style `tags.scm` def/ref queries feeding the
  existing `pagerank()`/`rankSymbols`. Order: **Python → Go → Java** (Octoverse
  2025: 6 languages = 80% of new repos; agentmap already owns TS #1 / JS #3).
  Effort ≈ 1–2 weeks for the backend interface + Python, then ~1–3 days/language.
  **Do NOT** use native node-tree-sitter (node-gyp ABI hell), `@ast-grep/napi`
  (immature 0.0.x lang packages), ctags (why Aider left it), or LSP/SCIP
  (violates "no server"). **Never** replace ts-morph for TS/JS.

**Verdict:** ship the `extractFacts()` backend interface in **Batch 2** (it's
required for testability/modularity anyway → cheap optionality), invest in
**TS-depth** (Batch 5), and only pull the tree-sitter tier forward if
post-distribution demand actually asks for Python. Being the definitive TS/JS
context tool beats being a mediocre polyglot for a solo maintainer.

Full research (with source URLs) is in the audit report — see *References* below.

---

## Status at a glance

| Batch | Theme | Effort | State |
|---|---|---|---|
| **1** | Trust & truth (security + honesty) | 1–2 d | ✅ **DONE** (pushed) |
| **2** | Modularize for testability + backend seam | 2–4 d | ✅ **DONE** — all substantive tasks landed (map byte-identical, 189 tests). Deferred-optional: `lib/` file split + in-process MCP. |
| **3** | Dirty-tree performance | 3–5 d | ⬜ |
| **4** | Distribution & release hygiene | 2–3 d | 🟨 Mostly done — plugin/marketplace, MCP Registry listing, tag-triggered publish, and README trust markers shipped; `npx skills add` alignment + Cursor/Gemini hooks deferred |
| **5** | TS-depth before language-breadth | weeks | 🟨 Mostly done — depth + resolution shipped; monorepo intelligence + symbol-PageRank deferred |
| **B** | Cross-cutting backlog (low-severity) | ongoing | ⬜ |

**Legend:** ✅ done · 🟨 partial / mostly done · ⬜ not started

---

## ✅ Batch 1 — Trust & truth (DONE)

Landed on `claude/ada-open-repo-577nj3` (commits `bd13785`, `17e0f2e`,
`2dcd5d4`, `1ced1b9`). For the record:

- [x] **RCE fix** — `hooks/post-commit` no longer runs a working-tree
  `./agentmap.mjs` by default; requires `AGENTMAP_HOOK_ALLOW_LOCAL=1` opt-in;
  PATH fallback verified to resolve to `@raymondchins/agentmap`. +2 tests.
- [x] **MCP crash-masking** — `mcp.mjs` surfaces exit-1-with-empty-stdout as
  `isError` instead of a false "no results"; detects string spawn-error codes.
  +3 protocol tests (`test/mcp-protocol.test.mjs` — server had zero coverage).
- [x] **CI glob** — `.github/workflows/ci.yml` runs `npm test` (159) not
  `node --test test/*.test.mjs` (116, skipped all of `test/vue-sfc/`).
- [x] **`*.password*` → `*password*`** exclusion bug + secret-leak regression test.
- [x] **Docs truth-sync** — SECURITY.md, README, hooks/INSTALL.md, CONTRIBUTING.md
  (cache paths, removed `--refresh`/`scripts/` refs, `--setup-mcp` row, Vue SFC in
  Scope); CHANGELOG backfilled 0.5.0/0.6.0/0.9.0 + fixed compare links.

---

## ⬜ Batch 2 — Modularize for testability + the backend seam

**Goal:** make the core importable and split `build()` so pure algorithms are
unit-testable, MCP can run in-process, a real library API exists, and a second
language backend becomes a drop-in. **This unblocks Batches 3 and 5.**

**Why first:** every downstream win (in-process MCP, dirty-tree incremental
rebuild, multi-language optionality, a documented API) is gated on this.

### Tasks

- [x] **`main()` guard + exports** — `agentmap.mjs:1458` runs the whole arg-parse
  + dispatch chain (1458–1831) as module side effects with `process.exit()`
  calls, and the file exports nothing → importing it executes the CLI and writes
  a cache into the importer's cwd. Wrap dispatch in a `main()` guarded by the
  `import.meta.url` check `mcp.mjs:204` already uses; export the pure functions
  (`pagerank`, `rankSymbols`, `identMul`, `resolveFile`, `extractVueScripts`,
  `stripJsonComments`, `build`, `ensureFresh`, `readPackageVersion`).
  *(architecture/high)*
- [x] **Extract `extractFacts()` backend interface from `build()`** —
  `agentmap.mjs:470–696` fuses parsing, module resolution, graph construction,
  ranking, and cache persistence. Extract:
  `extractFacts(repo) → Map<path, {exports:[{name,kind}], importedSymbols:{target:[names]}, reExports, defaultExportName}>`
  with the ts-morph+Vue code as the first backend; `build()` becomes
  backend-agnostic assembly (dependents inversion `:656`, PageRank `:658–665`,
  rankSymbols `:668`, persist `:688–693`). *(architecture/high)*
- [x] **Hoist the source-extension list** — currently hardcoded in 5 places
  (`dirtyCount` regex `:101`, `SRC_EXT` `:113`, `makeProject` git-ls-files filter
  `:411`, non-git glob `:424–427`, `RES_EXT` `:493`) into one per-backend
  descriptor. Prerequisite for any second backend. *(architecture/high)*
- [ ] **Suggested file split** (optional but recommended): `lib/backend-ts.mjs`
  (makeProject, extractVueScripts, resolvers), `lib/rank.mjs` (pagerank,
  rankSymbols, identMul), `lib/cache.mjs` (ensureFresh, sourceFingerprint,
  dirtyCount), `lib/setup.mjs` (installHooks, setupMcp, doctor — ~570 lines),
  `agentmap.mjs` as a thin bin shim. Keep `mcp.mjs`/`skills/install.mjs` working.
- [x] **De-dup module resolution** — `agentmap.mjs:541`: an inner `join` shadows
  `node:path`'s join and `resolveSpec`'s relative branch re-implements
  `tryResolveAt`. Collapse to:
  `resolveSpec = (fromAbsDir, spec) => spec.startsWith(".") ? tryResolveAt(joinPosix(fromAbsDir, spec)) : resolveAlias(spec, fromAbsDir)`.
  *(architecture/medium)*
- [x] **Declarative command table** — `agentmap.mjs:1602`: flag parsing is
  order-insensitive set membership, so orphan sub-flags (`--focus` without
  `--map`) and conflicting commands are silently accepted. Add a post-parse
  validation pass (exactly one command; each sub-flag declares its parent; exit 2
  on violation). *(architecture/medium)*
- [x] **Unify writer/checker pairs** — `agentmap.mjs:1142`: `setupMcp` vs
  `MCP_TARGETS`, `installHooks` vs `collectHookStatus` duplicate targets/predicates
  kept in sync only by comments. Hoist one shared TARGETS/PREDICATES structure per
  pair. *(architecture/medium)*
- [x] **Exit-code contract** — `agentmap.mjs:1724`: `--map --focus` with no match
  silently degrades to global ranking + exit 0 (every other unresolved query is
  exit 1); maintenance-command failures reuse exit 1 (documented as "zero
  results"). Reserve exit 1 for empty query results, move maintenance failures to
  exit 2/3, add `focusResolved:false` to JSON, and update USAGE + `mcp.mjs`'s
  classifier together. *(architecture/medium — coordinate with the MCP classifier
  touched in Batch 1)*

### Enabled once done (fold into this batch or Batch 3)
- [ ] **In-process MCP** — `mcp.mjs:110` spawns a fresh Node process + re-parses
  the whole map + 2 git subprocesses per tool call. After exports exist, run
  queries in-process against a map parsed once, invalidated by (sha,
  dirty-fingerprint). *(performance/low)*
- [x] **Direct unit tests** (started — `test/unit.test.mjs`, 9 in-process tests) —
  with pure functions exported, add real unit tests
  for `pagerank`, `rankSymbols`, `resolveFile`, `stripJsonComments` (no subprocess
  spawn) — cheaper and faster than the black-box harness.

**Acceptance:** `import('agentmap.mjs')` has no side effects; `node agentmap.mjs`
still behaves identically; `npm test` green; at least one in-process unit test
exists.

---

## ⬜ Batch 3 — Dirty-tree performance

**Goal:** stop full-reparsing the whole repo on every query when the working tree
is dirty. Agents work on dirty trees essentially always, so this is the #1
real-world experience killer — and fixing it turns agentmap's always-fresh
behavior into a real competitive claim vs CodeGraph's 2s sync.

> 📐 **Full implementation-ready design + measured baseline:**
> [`docs/batch3-dirty-tree-perf.md`](docs/batch3-dirty-tree-perf.md) (2026-07-03
> research pass). Measured: warm clean cache = 0.10s, but **every** dirty query
> re-parses the whole repo — content-os (370 files) = 1.67s per query, and
> dirty #2 ≈ dirty #1 (zero reuse). Two-tier plan: Tier 1 dirty-map cache
> (~0.5 day, zero risk, byte-identical, ~16× on repeated dirty queries) → ship
> first; Tier 2 true incremental (~2–3 days). Also found: a cache-poison one-shot
> rebuild on the dirty→clean transition (fold the fix into Tier 1).

### Tasks

- [x] **Dirty-map caching / incremental invalidation** — DONE (both tiers).
  **Tier 1:** dirty build cached to `.claude/agentmap/map.dirty.json`, keyed by
  `sha1(HEAD + dirty-file path:mtime:size)` → back-to-back dirty queries reuse one
  rebuild (~15×, byte-identical). **Tier 2:** modify-only true incremental —
  re-parse just the changed files against empty ts-morph stubs of the rest, re-run
  the cheap global assembly; byte-identical to a full rebuild (~2.9× on dirty-1).
  **Tier 2 ships EXPERIMENTAL / opt-in (`AGENTMAP_INCREMENTAL=1`)** — three
  adversarial rounds found a residual isolated-reparse tail (`.d.ts` edges,
  package.json `exports` field, barrel+target), so the default dirty path stays
  Tier 1 (proven byte-identical). Promote to default-on once that tail is closed.
  Add/delete/rename + any re-export-barrel change fall back to a full dirty build
  (Tier-1 cached). As-built scoping is narrower than the original goal-tier design
  (see the "As-built" note in `docs/batch3-dirty-tree-perf.md`): incremental is gated
  to modifications because add/delete/rename shift file ordering + flip edges in
  files we don't re-parse, and `export … from` barrels resolve their `exports` list
  through targets that are empty stubs. Verified across 7 real repos + a 12-shape
  adversarial resolution suite. *(performance/high)*
- [x] **Cache-poison on dirty→clean transition** — DONE (fell out of Tier 1). A
  dirty build now writes `map.dirty.json` instead of clobbering `map.json`, so the
  clean `map.json` (dirty:0) stays valid and the dirty→clean transition serves it
  with no extra rebuild. *(performance/medium)*
- [~] **Build wall-clock budget + visible skips** — **visible skips DONE; budget not
  taken; the resolver swap REFUTED.** The `:638` anchor was stale (real sites: the
  `extractFacts` catch and `assemble`'s emit).
  - *Visible skips (shipped).* The silent drop was real and reproduced on 0.18.1: a
    4-file repo with one bad module specifier → `fileCount: 3`, `degraded: false`,
    exit 0, and `facts.json` seeded from the truncated build so the loss would
    persist into later dirty queries. Now recorded as `incomplete` / `skippedCount` /
    `skipped` in `map.json`, a stderr warning, and a `--doctor` `incomplete` check
    that flips `overall` off `ok`; schema 6 → 7 forces caches written before the fix
    to rebuild. Conditional spread ⇒ byte-identical for repos that index everything.
    `test/incomplete-map.test.mjs`.
  - *Budget (deliberately NOT taken).* A default wall-clock ceiling silently
    truncates maps on slow-but-healthy repos — a behavior change that needs its own
    decision, not a ride-along. The trigger is also narrower than assumed: the
    stack-overflow path needs ~3500–4000 `export * from` links at the default V8
    stack. An independent re-measure saw **zero** drops at 250/500/1000 files, and a
    5000-file chain ran >401s / 2.77GB **without** crashing. The everyday trigger is
    an ordinary unparseable file, which the skips work above already covers.
  - *`getModuleSpecifierSourceFile` → `resolveSpec` swap: REFUTED, do not do it.*
    Measured at 17ms of a 175s build (0.01%) and linear. The real cost is
    `getExportedDeclarations()`, measured independently at ~O(N^2.7) and ~O(N^2.9).
    The swap is a pure correctness regression: the hand-rolled ladder returns `null`
    for `./x.js` → `x.ts` (the normative ESM TS style under NodeNext/Bundler), for
    `./types` → `types.d.ts`, and for directory imports resolving via a nested
    `package.json` `"main"`. Trying ts-morph first with `resolveSpec` as fallback is
    already the correct design. *(performance/high)*
- [ ] **Incremental post-commit rebuild + lock** — `hooks/post-commit:67`: the
  hook re-parses the entire repo on every commit and concurrent rebuilds duplicate
  work with no locking. Diff `HEAD~1..HEAD` and re-parse only changed files + their
  direct dependents; add a lockfile / compare-and-skip on in-progress HEAD build.
  *(performance/medium — depends on Batch 2 incremental machinery)*
- [ ] **Memory ceiling** — ⚠ **THE REMEDY IN THE ORIGINAL ITEM IS REFUTED. Do not
  implement it.** Measured on content-os (393 files), four loop variants doing
  identical work: current = **411MB** peak / 0.96s; `forgetNodesCreatedInBlock` per
  file = 428MB / 0.96s (+2%, i.e. recovers nothing); `sf.forget()` per file =
  **1,420MB / 59s**; `project.removeSourceFile` per file = **1,722MB / 89s** — 3.4×
  WORSE peak, 93× slower, **and it changed the map** (3 files flipped their
  `next/cache` resolution). Dropping a file invalidates the `ts.Program`, so the next
  `getModuleSpecifierSourceFile()` rebuilds the whole ~300MB `.d.ts` closure: O(n)
  rebuilds. It is also structurally wrong here — `tryResolveAt` uses
  `project.getSourceFile()` as the repo-wide resolution index, and
  `getExportedDeclarations()` resolves through barrels, so a consumed file must stay
  resolvable for every file parsed after it.
  The premise was wrong too: nothing is **held**. `heapUsed` falls to ~30MB the
  instant `extractFacts()` returns, on all 5 repos measured — it is a peak, not a
  leak. And **file count is the wrong axis**: a 252-file Next.js app peaks at 683MB
  while 4,000 dependency-free files peak at 756MB, because the dependency `.d.ts`
  closure (~300MB, ~1,800 extra program files on content-os) dominates and is
  independent of repo size. A file-count envelope would cry wolf on small dep-heavy
  repos and stay silent on the big repo it exists for.
  **Still open, rescoped:** sample real `heapUsed` during the parse and print one
  actionable warning (with the `--max-old-space-size` fix) before an OOM kills the
  build with no map at all; document the measured envelope. *(performance/medium)*
- [x] **Cap unbounded symbol matches** — DONE. `--find`/`--any` symbol matches are
  ranked by the containing file's PageRank and capped to `SYMBOL_MATCH_LIMIT` (50),
  with a "showing top N of M by pagerank — narrow your query" footer in prose and
  `total`/`shown`/`truncated` (`--find`) / `symbolsTotal`/`symbolsTruncated`
  (`--any`) in JSON. Ranking keeps the important matches when truncated.
  *(performance/medium)*
- [ ] **Prune rankSymbols cross-product** — `agentmap.mjs:736`: refs×defs edge
  list per identifier is quadratic on duplicated export names. Skip identifiers
  whose definer count exceeds a threshold (near-zero signal after the 0.1
  multiplier) or aggregate into per-defFile summary edges. *(performance/low)*

**Acceptance:** a second query on an unchanged dirty tree does not re-parse;
a pathological deep-chain repo finishes within the budget with skipped files
reported; `npm test` green + a concurrency test (see Batch B).

---

## 🟨 Batch 4 — Distribution & release hygiene

**Goal:** fix the "near-zero market footprint" problem (agentmap doesn't surface
in searches for its own category, and an unrelated `agentmap` npm package collides
with the name). Near-zero code; sequence *after* Batches 1–3 so what gets
discovered is trustworthy and fast.

### Distribution (from the agent-ecosystem research)
- [x] **Claude Code plugin + marketplace** — add `.claude-plugin/plugin.json`
  bundling the PreToolUse nudge hook (via `${CLAUDE_PLUGIN_ROOT}`), SKILL.md, and
  the stdio MCP server; add `.claude-plugin/marketplace.json` so
  `/plugin marketplace add raymondchins/agentmap` works; submit to
  `anthropics/claude-plugins-official`. (Plugins can't install git hooks — keep a
  SessionStart hook or `--install-hooks` for the post-commit refresh.)
- [x] **Official MCP Registry listing** — add `mcpName: "io.github.raymondchins/agentmap"`
  to `package.json`, run `mcp-publisher init && login github && publish`. Low
  effort (package already on npm); feeds Smithery/mcp.so/PulseMCP.
- [ ] **`npx skills add` compatibility** — align repo layout so
  `npx skills add raymondchins/agentmap` works (already ships SKILL.md); gets on
  the skills.sh leaderboard, distributes across Claude/Cursor/Codex at once.
- [x] **Codex CLI PreToolUse hook** — biggest enforcement gap; extend
  `--install-hooks` to write a `hooks.json`/`config.toml` PreToolUse matcher
  returning `permissionDecision: deny` + reason (do NOT use `additionalContext` —
  Codex fails open on it). **Guard:** a hard `deny` on grep must carry an
  allow-fallback (non-source paths, map-build-failed, repeat query) or it'll drive
  uninstalls — agentmap only covers TS/JS/Vue. Same pattern for Copilot CLI.
- [ ] **Cursor `hooks.json` + Gemini CLI extension** — upgrade Cursor from
  rule+MCP to a `beforeShellExecution` hook redirecting grep/rg to agentmap;
  package a Gemini extension (`hooks.json` + GEMINI.md + MCP) for the gallery.

### Release engineering (from the completeness critic — uncovered dimension)
- [x] **Tag-triggered publish workflow** with `npm publish --provenance`
  (`.github/workflows/publish.yml`) — `v*` tag push → test gate → provenance publish
  → GitHub Release, with a tag/`package.json` version-drift guard. Tags already
  existed (the "zero tags" note was stale); still need the `NPM_TOKEN` repo secret
  + first GitHub Release. *(v0.10.0 published manually 2026-07-03 to close the RCE gap;
  future releases go through this workflow.)*
- [ ] **Release automation** (release-please / changesets) — structurally fixes
  the recurring missing-CHANGELOG-entry problem (and the lockfile-version drift
  just seen in `aa62353`).
- [x] **README trust markers** — states "fully local, no network calls, no telemetry"
  (verified: zero `fetch`/`http` in `agentmap.mjs`/`mcp.mjs`) and the name-collision
  note (`npx agentmap` unscoped is an unrelated package; always use the scoped
  `@raymondchins/agentmap`). Landed in the intro blockquote.
- [x] **Fix the Gemini nudge (functional bug, do here or Batch B)** —
  `hooks/agentmap-gemini-nudge.mjs:59`: BeforeTool doesn't support
  `additionalContext`, so the nudge is silently dropped. Move to AfterTool
  `additionalContext` or BeforeTool `systemMessage`; update
  `install-helpers.mjs`. *(correctness-integrations/high)*

**Acceptance:** `npx skills add` works; MCP Registry + plugin marketplace entries
live; a tagged release publishes with provenance; README states the privacy
posture and the name-collision caveat.

---

## 🟨 Batch 5 — TS-depth before language-breadth (the long bet)

**Goal:** become the *definitively best* TS/JS context tool. Deepen the ts-morph
moat rather than diluting it. Revisit tree-sitter multi-language only if
post-distribution demand asks for Python (Batch 2's seam makes it a 1–2 week add).

### Correctness prerequisites for credible monorepo claims
- [x] **tsconfig `extends` baseUrl/paths origin bug** — DONE. `baseUrl` is now
  anchored to its defining config's dir at read time (`joinPosixAbs(here, …)` in
  `readTsconfigAliasOpts`), so inherited alias/paths resolve against the base
  config's origin, not the child's. *(correctness/high)*
- [x] **Longest-prefix alias rule** — DONE. `resolveAlias` sorts `paths` entries by
  descending specificity (exact patterns first, then longest fixed prefix) matching
  TS semantics; stable sort keeps non-overlapping repos byte-identical. *(correctness/medium)*
- [x] **tsconfig edits invalidate cache** — DONE. A new `dirtyConfigFiles()` (fed by
  the shared `parsePorcelain()`) makes a dirty `tsconfig.json`/`jsconfig.json` bust
  the cache + re-key `dirtyFingerprint`, WITHOUT entering the Tier-2 source
  changed-set. *(correctness/medium)*
- [x] **`git mv` to non-source staleness** — DONE. `dirtyFiles()` now counts a
  rename when EITHER side is a source file. *(correctness/medium)*
- [x] **Non-ASCII filenames** — DONE. `git ls-files` calls go through `gitListFiles()`
  (`-z` NUL-split); `git status`/`git grep` use `-c core.quotePath=off` — non-ASCII
  files stay in the map. *(correctness/medium)*
- [x] **`resolveFile` prototype pollution** — DONE. `resolveFile` uses
  `Object.hasOwn(filesObj, q)`, so `--any constructor` / `--relates toString` no
  longer crash or fabricate a hit. *(correctness/medium)*

### Resolution gaps beyond tsconfig (uncovered — needed for monorepo depth)
- [x] `package.json` `"imports"` subpath maps (`#internal/*`) — resolve to source
  (JSON-parsed, never executed) alongside tsconfig / vite / workspace resolution.
- [x] `vite.config` / webpack `resolve.alias` (zero support today).
- [x] Workspace cross-package resolution (`import '@org/pkg'` → `packages/pkg/src`
  via pnpm/npm workspaces).

### The depth features (competitive bets #1 and #4)
- [x] **Non-exported symbol indexing** — `--find` / `--any` (+ MCP) surface
  non-exported top-level declarations as discovery-only `locals`; never ranked, so
  `--map` / `--symbols` / `--hubs` stay byte-identical. `--no-locals` opts out.
  (schema 4). A precursor to the call-graph + BM25 bets below.
- [x] **Compiler-accurate call graph — `--callers`** — ts-morph language-service
  reference finding resolves who CALLS a symbol (compiler-accurate, not tree-sitter
  name-matching): type-position mentions, re-exports, and same-named locals in other
  files are never mis-attributed. Lazy + out-of-band (spins up the type-checker only
  on the query) so the map build + every other query stay fast; nothing persisted.
  Exposed as CLI `--callers` + the `callers` MCP tool. Experimental.
- [x] **Outgoing call graph — `--calls`** — resolves the in-project symbols a symbol
  invokes (compiler-accurate via `getDefinitionNodes`, follows imports/re-exports to
  the real declaration; constructors + member calls resolve; dynamic/higher-order
  honestly skipped). Same lazy model as `--callers`; CLI `--calls` + `calls` MCP tool.
- [x] **Transitive `--depth N`** — `--callers` / `--calls` take `--depth N` (max 5)
  for an N-hop caller/callee closure over the same warm Project (cycle-detected,
  per-level + total-node caps; `depth 1` byte-identical to single-hop). CLI flag +
  `depth` MCP arg; nodes tagged `depth` + `via`.
- [ ] **Symbol-level PageRank** — DEFERRED. A full symbol call graph needs
  `findReferences` over EVERY symbol (2–3 orders of magnitude more work than the
  file-import PageRank), which can't ride the fast build path and can't be cached
  without going stale on the first edit. Revisit only with an incremental,
  edit-surviving symbol-reference index. File-level PageRank already ranks
  `--find` / `--callers` results well.
- [ ] **Monorepo/framework intelligence** — first-class pnpm/turborepo/nx (per-package
  maps, cross-package edges), React server/client boundaries, tRPC routers, Prisma
  schema links, barrel-file flattening. Add a CI-buildable, compressed,
  team-shareable map artifact.
- [x] **Hybrid lexical retrieval without embeddings** (bet #5) — pure-JS BM25 over
  split-identifier tokens (name + path + feature + kind), fused with file PageRank,
  built into `map.json`. `--search <q>` + a rung in `--any` (fires only on exact-miss,
  so exact routing stays byte-identical) + `search` MCP tool. No vector DB.
  (Follow-up: tiktoken-style token budgets replacing chars/4.)

### User-configurable scoping (predictable first GitHub issue)
- [x] **`.agentmapignore` / config** — skip-list is hardcoded to
  `node_modules/.git/.next` (`agentmap.mjs:124,413,435,487`); no exclude/include
  globs, no extra-extension hook. `SRC_EXT` (`:113`) also indexes `.d.ts` generated
  declarations. Add a config file / `package.json` key / `--exclude` globs.

### Deferred (do NOT do yet)
- [ ] ⚠️ **SUPERSEDED by [Part II](#part-ii--make-it-useful-for-the-majority-2026-07-26).**
  The old item read: *"Tree-sitter multi-language tier (Python → Go → Java via
  `web-tree-sitter` + `tags.scm`). Gate on real demand."* Still deferred, but the
  plan changed on three points: the first spike language is **Go, not Python**
  (Go's resolver is a `go.mod` prefix strip — it measures a lower bound, and
  `go list -deps -json` gives free ground truth; Python's import model has
  permanently unfixable static-analysis gaps), "real demand" is replaced by a
  countable instrument because the old gate could not fire, and the whole tier is
  now gated behind a fidelity contract that forbids shipping a name-matched graph.
  See Part II Phases F, 2 and 3.

---

## ⬜ Batch B — Cross-cutting backlog (low-severity, do opportunistically)

### Security
- [ ] **Expand sensitive-file denylist** — `agentmap.mjs:77`: Batch 1 fixed
  `*password*`; still missing `*token*`, `.npmrc`, `.netrc`, `.git-credentials`,
  `.pgpass`, `.htpasswd`, `.pypirc`, `id_ed25519*`, `id_ecdsa*`, `*.p8`, `*.jks`,
  `*.keystore`. Reconcile with SECURITY.md; extend the regression test.
  *(security/medium — note `*token*` over-excludes `tokenizer.ts` etc.; weigh it.)*
- [ ] **Prompt-injection fencing** — `agentmap.mjs:1655`: untrusted repo content
  flows verbatim into agent context via `--any` content fallback + map digests
  through MCP. Wrap content/digest output in an untrusted-data fence in the MCP
  text result; strip control chars; document that `--any` lines are raw repo bytes.
  *(security/medium)*

### Tests & CI
- [ ] **OS matrix** — `.github/workflows/ci.yml:12` is ubuntu-only despite
  Windows-specific code + Windows-targeting docs. Add `windows-latest` +
  `macos-latest` (single Node version each). *(tests/high)*
- [ ] **Ranking-quality tests** — `test/determinism.test.mjs:40` only asserts
  determinism/set-membership, never *order*. Add fixtures with known in-degrees
  (hubs[0] = most-imported; leaf never outranks it); add a CI step running
  `eval/eval.mjs` with a min-accuracy threshold. *(tests/medium)*
- [~] **Concurrency + e2e hook tests** — parallel-build half DONE, hook e2e still
  open. Writing the test found a real bug rather than confirming safety:
  `assemble()` used a FIXED tmp name (`map.json.tmp` / `map.dirty.json.tmp` /
  `facts.json.tmp`) — the same literal path in every process — and nothing on the
  CLI/MCP query path locks. Two concurrent queries → the winner renames the shared
  tmp away and the loser's `renameSync` throws an uncaught ENOENT out through
  `main()`. Measured 2/18 processes pre-fix, 7/8 under a barrier. Fixed with
  per-writer `<target>.<pid>.tmp`; `test/concurrent-build.test.mjs` covers it with
  a timing-free guard (squat the legacy shared paths with directories → pre-fix
  `EISDIR`) plus a 6-way concurrency smoke test. Torn JSON — the hypothesised
  failure — did NOT reproduce (0 tears at 6MB and 96MB payloads); the crash was
  the defect. Still open: the shipped post-commit hook never runs e2e
  (`--install-hooks` without the hooksPath override → commit → `generatedSha ===
  HEAD`). *(tests/medium)*
- [ ] **Lint/typecheck gate** — add `jsconfig.json` (checkJs+strict) +
  `npx tsc --noEmit` (typescript already comes via ts-morph) + ESLint flat config;
  fail CI on either. *(tests/medium)*
- [ ] **Coverage floor** — run under c8 in CI, enforce e.g. `--lines 70` so
  unexecuted shipped files stay visible. *(tests/medium)*
- [ ] **Test env isolation** — `test/install-skill.test.mjs:84`: `--global` tests
  hit the real `$HOME`; git tests inherit host git config. Add `opts.env` to
  `helpers.run()`, route through a fake HOME, set `GIT_CONFIG_GLOBAL=/dev/null`.
  *(tests/low)*

### Correctness / integrations
- [x] **Claude nudge npx path** — `hooks/agentmap-nudge.mjs:116` tells the agent to
  run a `node_modules/...` path that doesn't exist for npx/global installs.
  Recommend `npx @raymondchins/agentmap --any` (as the Gemini nudge does). *(medium)*
- [ ] **Windows global Gemini path** — `skills/install.mjs:75` writes to
  `~/.agents/GEMINI.md`, which Gemini CLI never reads. Drop the win32 special case.
  *(medium)*
- [ ] **`--symbols N` silent cap** — `agentmap.mjs:1780` caps at 80 while claiming
  N. Recompute or clamp the printed count with a note. *(low)*
- [ ] **Installer robustness** — `skills/install-helpers.mjs:83`: opaque TypeError
  when an existing `hooks` key isn't an array → partial install. Validate shapes
  up front; validate all platforms before writing any file. *(low)*
- [ ] **JSONC comment preservation** — `skills/install-helpers.mjs:104`: rewriting
  `settings.json` strips comments silently. Surgical splice, or warn. *(low)*

### Docs / benchmark honesty
- [ ] **Benchmark headline** — `README.md:63`: only Scenario F's skew is disclosed;
  Scenario D also inflates the total (excluding both → ~89.8% / ~10× on ai-chatbot).
  Add the D+F-excluded figure; validate chars/4 once against a real tokenizer; re-run
  `npm run eval` post-0.8.0 and refresh dates/numbers. *(medium)*
- [ ] **Blast-radius row footnote** — `benchmark/RESULTS.md:26`: the 99.2% row is
  contradicted by EVAL.md (agentmap wins precision, loses tokens vs `grep -l`).
  Footnote it or add a `grep -l` baseline to `bench.mjs`. *(high, docs-only)*
- [ ] **Onboarding matrix + uninstall + troubleshooting** — `README.md:223`: add a
  per-CLI "commands to full loop / enforcement vs docs-only" matrix, a copy-paste
  `.cursor/mcp.json`, an **Uninstall** section listing every file the installers
  touch (there's no `--uninstall` command — consider adding one), and a
  Troubleshooting section (nvm PATH, 0-files-mapped, stale skills via `--doctor`).
  *(medium)*
- [ ] **Benchmark realism** — `benchmark/bench.mjs:26`: add wall-clock (cold/warm/
  dirty), include a 3–5k-file repo, report the excluding-F total. *(low)*
- [ ] **Competitor table** — `README.md:101`: Batch 1 fixed Aider's install; still
  update Repomix's agent-loop cell to "MCP server (no auto-refresh/nudge)", link
  every row to its repo, add an "as of \<date\>" footnote. *(low)*

### Housekeeping (from the completeness critic)
- [ ] Dead `statSync` import (`agentmap.mjs:16`); `readPackageVersion` implemented
  4× with divergent failure behavior — unify once modularized. *(low)*
- [ ] Duplicated recursive dir walk between `sourceFingerprint()` and `makeProject()`
  (`agentmap.mjs:431`) — extract one `walkSources()`. *(low)*
- [x] Node 18 is past EOL (Apr 2025) but in `engines` + CI matrix — decide support
  policy. Resolved: `engines` is `>=20` and the matrix is `[20, 22, 24]`. The floor
  is set by the dependency tree, not by EOL dates — `brace-expansion` (via ts-morph
  → @ts-morph/common → minimatch) declares `20 || >=22`, so `>=18` was a claim the
  tree contradicted. `dependabot.yml` now covers npm + Actions, with `ts-morph` on
  the weekly update path.
- [ ] Community health files: no `.github/ISSUE_TEMPLATE`, PR template,
  `CODE_OF_CONDUCT.md`, `FUNDING.yml`. CI Actions pinned by mutable tags (`@v5`),
  not SHA — a hardening gap the SECURITY.md advertises.
- [ ] Consider a neutral `.agentmap/` cache path (currently `.claude/agentmap/`
  even for Gemini/Codex/Cursor users) with back-compat.
- [x] `--export dot|mermaid` — file import graph → Graphviz DOT / Mermaid, top-N by
  pagerank, 3 style tiers, `--focus` scopes to a neighborhood; reads the cached map
  (no ts-morph Project). (Call-graph closure export = future v2.)

---

## References

- **Full audit report** (52 confirmed findings with evidence, 3 research reports
  with source URLs, completeness critique, contradictions) — generated
  2026-07-03. Ask Claude to regenerate from the workflow run, or see the session
  where this roadmap was created.
- **Key numbers (refreshed 2026-07-26):** single-file CLI (`agentmap.mjs`, **3,669
  lines**), one runtime dep (`ts-morph`), **Node ≥20**, **396 tests** green across
  92 files. *(Previously recorded here as ~1831 lines / Node ≥18 / 165 tests —
  stale on all three.)*
- **Competitive north star:** ⚠️ the old note read "CodeGraph (multi-language, 57k
  stars) owns breadth; agentmap wins on ts-morph compiler accuracy + honest eval +
  agent-loop wiring. Don't chase breadth; deepen TS." As of 2026-07-26 CodeGraph
  is at 62,450 stars and 35 languages, its eval is now public (so honest eval is
  no longer a differentiator), and `scip-query` — same compiler-accuracy class —
  out-downloads agentmap on npm. The conclusion still holds; the reasoning is
  restated with sources in **Part II §1**. Star counts in this category are
  inflated and are not used as an adoption proxy anywhere in Part II.

---

# Part II — "Make it useful for the majority" (2026-07-26)

> Second full audit pass: 4 code-recon dimensions + 3 external research reports +
> 3 competing strategy proposals, adjudicated. Same rules as Part I — every task
> carries a `file:line` anchor and a checkbox; every number carries a source or is
> explicitly flagged unverified.
>
> **This part supersedes the *Strategic decision* section at ROADMAP.md:21–58 and
> the "Deferred (do NOT do yet)" item at ROADMAP.md:372–375.** Where they
> conflict, this wins — it is later, and it is measured.
>
> Phases below are numbered 0–4 and run *after* Batch 5. They do not renumber the
> existing batches.

---

## 0. The question, and the honest answer

**Asked:** "make this more useful for the majority of people — multi-language support?"

Those are two questions, and conflating them is how this roadmap went wrong the
first time.

1. **"Useful for the majority"** — today, verifiably, **nobody can run it**. From
   v0.10.0 through v0.16.0 every documented install path (`npx`, `npm i -g`,
   `node_modules/.bin`, `npm run agentmap`, the Claude Code plugin, the MCP
   Registry entry, the post-commit auto-refresh) exited 0 having printed zero
   bytes. Verified below, against published tarballs.
2. **"Multi-language"** — a real question, but **unanswerable until (1) is
   fixed**, because every demand signal the old gate was waiting on was being
   read off a population that had never seen the tool emit output.

Fixing (1) is not a phase. It is the precondition, and it ships regardless of
which language strategy wins.

---

## 1. Verdict on the existing *Strategic decision* (ROADMAP.md:21–58)

**REFINED — the conclusion survives, the reasoning does not.**

The verdict ("build the seam now, defer the languages") is still right, and is
right for a solo maintainer for reasons the original section never stated. But
its gate was unfireable, its "seam" was not built, and three of its four
supporting claims are stale, wrong, or refuted.

| Original claim (line) | Verdict | Replacement |
|---|---|---|
| "only pull the tree-sitter tier forward if post-distribution demand actually asks for Python" (`:39–40`) | **Unfireable gate** | There was no distribution. The binary did not run for npm users. "ZERO issues requesting other languages" measures zero *working* users. The real signal arrived as **exits**, not issues: `rifanid98/agentmap-go` (2026-06-15) and `dstwn/agentmap-php` (2026-06-19, shipped in three days) — two independent language ports, neither of which filed a request first. A gate that waits for a filed issue is the wrong instrument. |
| "ship the `extractFacts()` backend interface in Batch 2 → cheap optionality" (`:37–38`, checkbox at `:101`) | **Materially incomplete** | What landed is an extracted *function*, not an *interface*. There is no backend registry, no `backendFor(path)`, no dispatch; `extractFacts(inc)` takes no backend parameter and calls `makeProject()`/`tsMorph()` unconditionally (`agentmap.mjs:1008–1009`). `assemble()` — documented as backend-agnostic at `:1280` — is **not exported** (`:3439`), so a second backend cannot live in another file. The optionality was not bought. |
| "hoist the source-extension list … one per-backend descriptor" (`:108–111`, marked `[x]`) | **Half done** | The list was hoisted (`:153–157`); the *consumers* were not. Nine call sites read the module constant, and there are two further hardcoded extension ladders that do not derive from it: `agentmap.mjs:674` and `eval/eval.mjs:54`. Swapping `CODE_EXT` swaps all languages at once; two backends cannot coexist. |
| "tree-sitter rivals are demonstrably noisy on call graphs" (`:26`) | **Refuted as framed** | The only hard evidence found (`tree-sitter-analyzer`'s miswire-audit: CodeGraph 745 mis-wires / 38,103 call edges = 1.96%, vs its own 6 / 114,160) comes from a tool that is **itself tree-sitter-based**. Noise is a *resolver-design* choice, not a parser property. Correct restatement: *some* implementations, including the category leader, ship measurable cross-language call-graph noise. ⚠️ Source is a 44-star adversarial competitor, self-published, measured on its own repo, and its README says it is "re-verifying" — treat as **likely, not verified**. |
| "honest eval methodology" is a differentiator (`:27`) | **No longer true** | CodeGraph now publishes measured per-language cross-file coverage on named public repos including unflattering ceilings. `EVAL.md` is still good practice; it is no longer a moat. |
| "compiler-grade ts-morph accuracy" is unmatched (`:25–26`) | **Overstated** | Serena is LSP-based across 40+ languages; `scip-typescript` is built on the TypeScript typechecker — same accuracy class as ts-morph — and `scip-query` does 4,934 npm downloads/month against agentmap's 3,266. The defensible claim is narrower: *the only zero-config, single-dependency, local, token-budgeted TS/JS repo map with compiler-grade resolution.* |
| "CodeGraph … ~57k stars, 20+ languages, 2s auto-sync" (`:23`) | **Stale / misread** | 62,450 stars and a 35-language table as of 2026-07-26. "2s" is a file-watcher **debounce quiet window** (tunable), not indexing latency — Batch 3's framing at `ROADMAP.md:160` attacks a number that is not a performance figure. Also: stars in this category are near-worthless as signal; use npm downloads. |
| "Entering [multi-language] = being the 4th-best polyglot" (`:24`) | **Optimistic** | Realistic entry position is 5th–8th. Four polyglot tools at 26k–96k stars launched inside six months. The conclusion (stay out) gets *stronger*, not weaker. |

**What does not change:** for one part-time maintainer, being the definitive TS/JS
tool beats being a mediocre polyglot. That call stands. Everything below is about
making it stand on measured ground instead of on a gate that could not fire.

---

## 2. Evidence that argues *against* the instinct

Stated plainly, because the plan is worse if these are buried.

- **Language coverage is the #1 or #2 request in every comparable project.**
  Serena's top issue is "Swift language support" (+34); CodeGraph's language
  tracker is +27. If reach is the goal, breadth is what people ask for.
- **~78% of new repos are not TS/JS.** Octoverse 2025: six languages ≈ 80% of new
  repos; Python 9.26M new repos vs TypeScript 5.39M. (JetBrains 2025 ranks TS #4
  at 22% of primary use — the addressable share is population-dependent, and this
  roadmap is betting on the more favourable population. Say so.)
- **A fork already did it.** `dstwn/agentmap-php` is the strongest existing
  multi-language demand datapoint and it exists because there was no channel for
  demand to arrive as an issue.
- **And the counter-evidence, which is stronger:**
  - **Accuracy is commercially invisible.** In CodeGraph's tracker, four open,
    reproduced, end-to-end-verified *wrong-edge* bugs sit at **+0 reactions**
    each, while a cosmetic Windows console flash has **+14** and install-target
    requests have **+36**. Accuracy is real, and nobody is scoring it.
  - **A graph index measured *less* accurate than no index at all still won.**
    arXiv 2603.27277 reports 83% answer quality for the graph-MCP agent vs 92%
    for a plain file-reading agent, adopted anyway on ~10× token savings; the
    project reached 35k stars.
  - **Python/Go/Java buys parity, not differentiation.** Every polyglot
    competitor already ships them. The live request tail is BrightScript,
    ReScript, Julia, Fortran, Terraform, GLSL, ABAP.
  - **A non-TS language would get a materially worse product.** See §6. Under any
    parse-only backend, **0 of the 11 MCP tools run at TS fidelity**: 7 degrade,
    4 must refuse.
  - **The real baseline competitor is free.** Claude Code deliberately ships no
    index (agentic Glob/Grep/Read) on precision, freshness, maintenance and
    privacy grounds. Every value claim has to beat *"just grep"*, not just beat
    CodeGraph.

**Net:** the instinct is directionally reasonable and the evidence does not
support acting on it yet — not because languages are wrong, but because the
denominator is zero and the fidelity cost is real and large.

---

## 3. Status at a glance (Part II)

| Phase | Theme | Effort | State |
|---|---|---|---|
| **0** | Repair the instrument — make the shipped commands run | 2–4 d | ✅ **DONE** — shipped as **0.16.1**. All five gate conditions met and now enforced in CI every run; 0.10.0–0.16.0 deprecated on npm. Only the day-14 baseline remains (a time-based measurement, not work). |
| **1** | Instrument demand + spend the 90-day window on TS/JS depth | 5–6 d build, then 90 d elapsed at ~0 cost | ⬜ |
| **F** | **The fidelity contract** — precondition for any non-TS byte | 4–6 d | ⬜ |
| **2** | Hard-timeboxed throwaway cost spike (Go), never merged | 5 d hard box | ⬜ |
| **3** | Ship exactly ONE language, experimental flag, `resolved` tier or not at all | 10–14 d | ⬜ |
| **4** | Promote or delete — binary, in writing | 3–5 d | ⬜ |

**Legend:** ✅ done · 🟨 partial · ⬜ not started · `[~]` moot/deprioritized, with the reason recorded inline

Total maintainer spend before any irreversible public commitment: **~7 working
days** (Phase 0 + the Phase 2 spike). The 90-day windows cost zero maintainer
time and are explicitly redirected to Phase 1B, not to idling.

---

## ⬜ Phase 0 — Repair the instrument (BLOCKING)

**Goal:** make every documented install path actually execute. Nothing downstream
is interpretable until this ships — there is no product strategy on top of a
binary that exits 0 with zero output.

**Why first, and why it is not a phase:** it is the precondition. It ships as a
patch release inside 48 hours regardless of which language strategy wins.

### Tasks

- [x] **Main-module guard** — `agentmap.mjs:3444` / `mcp.mjs:246` compared
  `import.meta.url` (realpath) against `process.argv[1]` (symlink path), so under
  any npm bin the guard read "imported", `main()` never ran, and the process
  exited 0 with zero bytes. **Landed in the working tree** as `isDirectRun()`
  (realpath compare) in both files, plus `test/bin-symlink.test.mjs` — 6 tests
  through a real symlink asserting on OUTPUT, not exit status, since exit 0 was
  the bug's own signature. Committed as `ae3365e`; suite 356 → **362 green**.
  **Not yet released — every published version is still broken.**
- [x] **Correct the affected-version range before it goes in a release note.** DONE —
  The new in-code comment says "from v0.12.1 (a217331) through v0.16.0". Measured
  against published tarballs: **v0.9.0 has no guard and works under a symlink;
  v0.10.0 is the first published version that is broken.** `git tag --contains
  a217331` starts at v0.12.1 because 0.10.0/0.11.0 were published manually off
  the same day's work (see `ROADMAP.md:262`). The affected set is **0.10.0 →
  0.16.0** (12 published versions). Independently re-confirmed by installing each
  published tarball and invoking through `node_modules/.bin/agentmap`: 0.8.0 and
  0.9.0 print their version, 0.10.0/0.11.0/0.12.0/0.12.1/0.13.0/0.15.1/0.16.0 all
  print nothing. The in-code comment and CHANGELOG now say 0.10.0–0.16.0. Separately, `mcp.mjs` has carried the guard
  since **0.2.0** (first published version shipping `mcp.mjs`), but that guard was
  latent: `--setup-mcp` writes a *direct path* for local installs
  (`agentmap.mjs:2358`), which works — the MCP surface died because the *npx*
  branch goes through the broken CLI bin.
- [~] **Fix the nudge test properly, not by inverting it.** DEPRIORITIZED — this
  was written while `npx` was broken, which made the test look like it was locking
  in a dead command. With 0.16.1 the asserted `npx` form is the correct, most
  portable recommendation (`node node_modules/...` genuinely ENOENTs on global and
  npx installs), so the test now asserts true behaviour. The deeper point still
  stands and is worth doing eventually — assert the runner the hook actually
  resolved rather than a hardcoded string — but it is no longer urgent. Original
  finding:
  `test/nudge-hook-grep-symbol.test.mjs:126–136` asserts the emitted command MUST
  contain `npx @raymondchins/agentmap` and MUST NOT contain the working
  `node node_modules/@raymondchins` form — the suite locks the broken command in
  and fails any outsider who fixes it. **Do not just flip the assertion to the
  other hardcoded string.** Have the hook emit the command for the runner it
  actually resolved (the same rung logic `hooks/post-commit:50–72` already
  implements) and assert *that*, so the emitted command cannot go stale against a
  future install shape the way it just did against this one.
- [x] **Add the missing CI test class.** DONE — `install-smoke` job (Node 20/22/24,
  ~15-19s each) packs, installs into a scratch consumer, and drives the real bin:
  symlink, npx, global install, `--mcp` JSON-RPC, and `--install-hooks` + a real
  commit that must move `generatedSha`. Verified on a clean runner:
  `generatedSha 4be1c17 -> 135ce42`. Original finding: `.github/workflows/ci.yml:52` runs
  `npm test`, `:56` runs `node agentmap.mjs --hubs`, `:60` runs
  `npm pack --dry-run` (executes nothing). 92 test files exercise the one path
  real users never take. Add: `npm pack` → `npm i -g ./tgz` → `agentmap --version`
  → `agentmap --hubs` → `npx -y ./tgz --mcp` JSON-RPC `initialize`.
- [~] **Fix the three downstream copies of the dead command.** MOOT as written —
  the commands are no longer dead. `npx @raymondchins/agentmap` works as of 0.16.1
  (verified against the live registry), so the hooks and SKILL.md now recommend a
  command that runs. The rung logic itself was never wrong. Original finding: `hooks/post-commit`
  rung 1 requires `AGENTMAP_HOOK_ALLOW_LOCAL=1` (`:52`) so npm users fall to rungs
  2–4 — `node_modules/.bin` symlink, PATH symlink, `npx` — all three guard-bug
  casualties, run detached and silenced at `:84`, while `--install-hooks` prints
  "Done — the map auto-refreshes on commit." Same dead `AM` constant in
  `hooks/agentmap-nudge.mjs:160`, `hooks/agentmap-codex-nudge.mjs:137`,
  `hooks/agentmap-gemini-nudge.mjs:90`, and `skills/agentmap/SKILL.md:49,69`.
- [x] **Disclose the dead maps already in the wild.** DONE — 0.10.0-0.16.0 (12
  versions) deprecated on npm via a new `workflow_dispatch` Deprecate workflow
  (local `~/.npmrc` token is expired, so the repo's `NPM_TOKEN` secret is the only
  path); an empty message un-deprecates, so it is reversible. Verified against the
  raw packument: all 12 flagged, 0.9.0 and 0.16.1 clean. Original finding: Existing installs have been
  serving maps frozen at install time under a "stays current on its own" promise.
  Ship an explicit release note stating post-commit auto-refresh was
  non-functional for npm-installed users, and run `npm deprecate` on 0.10.0–0.16.0
  pointing at the fixed release. For a tool whose value proposition is freshness,
  silently-stale maps are a trust liability a changelog line does not cover.
- [x] **Version + doc drift, one sweep.** DONE — `plugin.json` 0.14.0 -> 0.16.1,
  README badge >=18 -> >=20, `hooks/INSTALL.md` tsconfig-required claim corrected,
  the false vite/webpack warning at `:1420` replaced with the real gaps, and the
  MCP Registry re-published at 0.16.1. Plus the systemic fix the original item did
  not ask for: `test/version-lockstep.test.mjs` now fails `npm test` if
  `server.json`, `plugin.json` or the README badge drift from `package.json` —
  `publish.yml` only gated `server.json`, which is how `plugin.json` slipped two
  minor versions with every check green. Original finding: `.claude-plugin/plugin.json:5` is
  `0.14.0` against `package.json` 0.16.0 and `server.json` 0.16.0.
  `README.md:24` badges node `>=18` against `engines: >=20` — actively misleading
  after the 0.16.0 breaking change. `hooks/INSTALL.md:28` states "The repo must
  have a `tsconfig.json`" — **false**; `makeProject()` falls back to source globs
  and the code says so at `agentmap.mjs:823–825`. `agentmap.mjs:1420` tells users
  vite/webpack aliases "aren't read yet" — **false**; `readBundlerAliasEntries()`
  (`:587`) AST-parses them, `bundlerAliasToPaths()` (`:642`) normalizes them, and
  `test/vite-alias.test.mjs` covers it. Republish the MCP Registry listing (stale
  at 0.12.1).
- [x] **`--doctor` must stop greenlighting a broken map.** DONE — a 0-file map now
  reports `invalid`, a low-edge-coverage map reports `degraded` with the measured
  percentage, and both roll into `overall`. Exit code stays 0: `README.md:761`
  documents `--doctor` as always exiting 0, so the report was the bug, not the exit
  code. Pre-schema-5 caches lack the fields and still read `ok`. Original finding: `degraded` is computed
  at `agentmap.mjs:1382` and consumed only by the stderr warning at `:1419`;
  `collectMapStatus()` (`:2210–2265`) never reads it, `fileCount`, or
  `edgeCoverage` — so `--doctor` reports "Map cache: ok" with exit 0 for a map
  containing zero files. This is the single most dangerous thing to leave unfixed
  before any partial-resolution backend exists.
- [ ] **Record the post-fix baseline on day 14** — downloads/week **and** inbound
  non-security issue count. This pair is the denominator for every later gate.

### Gate (binary, in CI, no interpretation) — ✅ MET 2026-07-26

All five verified on clean GitHub runners on Node 20/22/24, and they are no longer
a one-time check: the `install-smoke` job asserts every one of them on each push,
so this gate cannot silently regress the way it silently broke.

On a clean runner with no repo checkout, on Node 20/22/24, **all five**:

1. `npx @raymondchins/agentmap --version` prints a version.
2. `npm i -g <tarball> && agentmap --hubs` prints a map.
3. `./node_modules/.bin/agentmap --any <q>` prints a result.
4. `npx -y @raymondchins/agentmap --mcp` answers `initialize`.
5. `--install-hooks` followed by a real commit **measurably rewrites
   `map.json`'s `generatedSha`.**

Gate 5 is the one the obvious test plan misses, and it is the one that would have
caught the dead auto-refresh. Measured on the runner: `generatedSha 4be1c17 ->
135ce42`, i.e. a real commit really does rebuild the map again.

### Kill

- Gate not met, or slipped past 3 weeks → stop everything else. There is no
  strategy on top of a binary that prints nothing.

---

## ⬜ Phase 1 — Instrument demand, and spend the window on TS/JS depth

**Goal:** replace a demand detector that provably cannot fire (wait-for-an-issue)
with one that can — and put the 90 days of waiting to work, not to idling.

### 1A — The demand instrument (2–3 d)

- [x] **In-CLI language census.** DONE — `languageCensus()` buckets `git ls-files`
  by extension and fires when one unsupported language is >=30% of counted SOURCE
  files (docs/data deliberately excluded, or a markdown-heavy TS repo would trip
  it). Prints counts, share, and the vote link on **stderr** so `--json` stays a
  clean contract; `AGENTMAP_NO_CENSUS=1` opts out. 6 tests cover both failure
  modes — silent on a repo that is the wrong fit, and nagging one that is fine.
  Original spec: Count tracked sources by extension over
  `git ls-files`, including extensions with no backend. When ≥30% of tracked
  sources are a single unsupported language, replace the generic warning at
  `agentmap.mjs:1418` with a specific one: *"agentmap sees 412 `.py` and 3 `.ts`
  files. agentmap is TS/JS-only today — vote for Python here: `<url>`."* This is
  the only signal in play that **cannot be bot-inflated**, because it takes a
  human GitHub account to react.
- [x] **One pinned issue** — DONE: [#43](https://github.com/raymondchins/agentmap/issues/43),
  pinned, with one comment per language (Python/Go/Java/Rust/C#/PHP/other) so
  reactions are countable at a glance. Original spec: reaction-voted, linked from the README, the census
  message, and the MCP error text. One issue, not a discussion board — it must be
  countable at a glance.
- [x] **Publish the capability matrix (§6) *before* building anything** — DONE.
  In the README as *What another language would actually get*, and repeated at the
  top of #43 with the explicit ask: would you still use it if `--callers`/`--calls`
  refused and `--features` returned nothing? Original spec: and ask
  voters directly: *would you still use it if `--callers`/`--calls` returned an
  explicit unsupported error and `--features` returned nothing?* The cheapest way
  to discover you are being asked for a different product is to describe the
  product accurately first.
- [x] **Add a "Forks & ports" README section** — DONE, both ports listed and
  linked, marked unaffiliated/unendorsed. Original spec: linking **both** language ports.
  There are two, not one: `dstwn/agentmap-php` (created 2026-06-19, pushed
  2026-06-22) and **`rifanid98/agentmap-go`** (created 2026-06-15) — the Go port
  was missed during research and found by direct enumeration of the fork list.
  Two independent people chose to fork rather than file an issue, which is the
  single strongest refutation of the "zero demand" reading. Converts the best
  existing demand datapoint from invisible to tracked for about an hour of work;
  contacting them about upstreaming is cheaper than competing with them.
- [x] **Ship NO telemetry.** DECIDED AND RECORDED — stated in the README next to
  the matrix and in the census code comment, so it is not relitigated: the census
  counts locally, prints locally, and nothing leaves the machine. Original
  reasoning: For a solo-maintainer OSS dev tool the trust cost
  outweighs the data-quality gain. Record it as a decision so it is not
  relitigated — and accept that every gate below is therefore a lagging,
  loudness-biased proxy with wide error bars.

### 1B — TS/JS depth (2–3 weeks part-time, ~25–30 focused hours)

This is the content of the waiting window. Capacity goes here, not to idling.
Every item is genuinely underserved and structurally beyond a tree-sitter tool,
because it needs the checker or the resolver.

**Status: 6 of 7 closed, 1 partial.** Worth recording what the closures actually
were, because it is not what this section predicted. Two items closed as NOT-A-GAP
once measured. Of the four built, **three turned out to be repairs rather than
additions** — `--callers` failing outright on `export *`, type-only dependents
missing entirely rather than merely unlabelled, and wildcard/nested `exports`
resolving to nothing. Each was a shipped command answering confidently and wrongly
under a "compiler-accurate" label. The depth frontier this section set out to
extend was, in three of four cases, a floor that needed fixing first.

- [x] **tsconfig `references` (project references).** **CLOSED — NOT A GAP.**
  The premise was wrong on both halves, and measuring it is what showed that.
  (a) Project references are not a module-resolution mechanism — they govern
  build order and declaration output. TypeScript resolves cross-package imports
  via relative paths, `paths`, or node_modules/workspaces, and agentmap already
  handles all three. Checked against TypeScript's own `ts.resolveModuleName`: a
  package-name import with references but no `paths` and no `package.json` is
  TS2307 in tsc too, so reporting no edge there is the correct answer.
  (b) A narrow or solution-style `include` never limited the file set anyway —
  `makeProject` reads tsconfig for compiler options and then adds everything
  `git ls-files` returns that `include` missed. That was deliberate, and the
  comment at the call site says so.
  Measured across 7 fixture shapes (solution-style, narrow include, partial
  include, no tsconfig, paths, workspace package.json, unresolvable); all index
  the full repo and resolve the cross-package edge except the one tsc rejects.
  Locked in by `test/monorepo-shapes.test.mjs`. The degraded-map warning no
  longer names `references` as a known gap. Original claim: The ~296-line resolver at
  `agentmap.mjs:530–825` covers extends-chains, `baseUrl`, `paths`, vite/webpack
  alias, `package.json` `imports`/`exports`, and workspace discovery — project
  references, **the** defining monorepo primitive, are absent. Verified: the only
  occurrence of the word in the file is the comment at `:824` noting that
  solution-style configs index 0 files.
- [x] **pnpm `workspace:*` and `catalog:` protocols** — **CLOSED as written; a
  REAL gap found next door.** The protocols themselves are a non-issue:
  `discoverWorkspacePackages` maps package-NAME -> source dir by scanning every
  `package.json` with a `name`, and never reads the dependent's dependency
  specs — so `workspace:*`, `workspace:^`, `catalog:` and a plain semver range
  all resolve identically (measured, 4 shapes).
  What DID break was entry selection. A workspace package declares its
  PUBLISHED entry (`main: "dist/index.js"`) and `dist/` is gitignored, so
  resolution landed on a file not in the repo and the cross-package edge
  vanished silently. Three shapes returned ZERO dependents, including
  `main: dist + types: src` — a plain correctness bug, since TypeScript resolves
  `types`/`typings` AHEAD of `main` and agentmap read neither. Fixed: `types` /
  `typings` and the `types` export condition now come first, plus a
  `./src/index` last resort for packages whose only declared entry is unbuilt.
  A declared entry that resolves always wins — asserted. 7 tests in
  `test/workspace-entry-resolution.test.mjs`. Original spec:
  `discoverWorkspacePackages` (`:767–808`) / `resolveWorkspace` (`:1106–1124`).
  Verified: **zero occurrences** of either protocol string in `agentmap.mjs`.
- [x] **Broaden conditional exports**, and fix the latent bug at `:674` — **DONE,
  and the item was understated: two LIVE resolution bugs were found next to the
  latent one.** (a) `exports` subpath PATTERNS (`"./wild/*": "./src/wild/*.ts"`)
  were looked up by exact key only, so every wildcard subpath in a workspace
  package produced no edge at all — exit 0, no warning. (b) NESTED conditions
  (`{"node":{"import":"./src/x.ts"}}`) were read one level deep and abandoned when
  no top-level value was a string. Both now resolve: `condLeaf` became
  `condTargets`, walking recursively and returning every candidate in precedence
  order, and a new `matchSubpath` implements Node's pattern rules with
  longest-prefix-wins. Array targets are now Node's fallback list — tried in order
  until one exists on disk, which the `.` entry already did and subpaths could not.
  Precedence stays source-first (`types`→`typings`→`import`→`default`), not Node's
  runtime order, for `05ef8dc`'s reason: this tool never executes the package.
  (c) The named latent bug was confirmed **latent, not live** — the ladders agreed
  today, so it was a regression waiting rather than a break. The census also found
  **8 hardcoded extension lists, not the 2 this roadmap named** — `VITE_CONFIG_RE`
  was silently skipping `vite.config.mts`/`.cts`, and `eval/eval.mjs`'s git-grep
  pathspec was missing `*.cjs`, meaning the grep BASELINE searched fewer files
  than agentmap mapped. The guard is a test that iterates the live `CODE_EXT`
  constant instead of restating it (restating would just be a ninth copy), proven
  to fail when the two are forced apart.

  An adversarial pass checked the new pattern matcher against a real Node v26
  rather than against the prose of the spec, and caught two conformance defects
  in the first cut: the equal-prefix TIE-BREAK resolved by JSON declaration order
  where Node ranks by longer full key (Node's own docs pair `"./lib/*"` with
  `"./lib/*.js"`, so the tie is an idiom, and getting it wrong both missed the
  right dependent and misattributed the edge), and an EMPTY wildcard fill was
  accepted where Node raises `ERR_PACKAGE_PATH_NOT_EXPORTED`. Both fixed and
  pinned by tests proven to fail against the first cut. Reading the spec was not
  enough; running the runtime was.
- [x] **Type-only edges as a first-class attribute.** **DONE — and the framing was
  too gentle.** The information wasn't merely unlabelled: a fully `import type` /
  `export type` declaration was dropped before any edge was recorded, so the
  imported file's `dependents` came back EMPTY. Measured on
  **vercel/chatbot@c2f8235e**: `lib/types.ts` has 23 importers, all 23 type-only,
  and `--relates` reported `dependents (0): —` — a file the whole app depends on,
  indistinguishable from an orphan. 22.4% of that repo's import statements are
  type-only. They now land in `typeOnlyImports`/`typeOnlyDependents`, disjoint from
  `imports` and absent when empty. The exclusion from PageRank was CORRECT and is
  preserved — the original comment (*"type-only modules must not inflate runtime
  PageRank"*) was right about the graph and wrong about throwing the fact away.
  PageRank, `edgeCoverage`, `rankSymbols` and `--export` are all provably
  unchanged, asserted by a same-file-count control repo rather than assumed.

  An adversarial pass over the finished work then found the inverse bug next door:
  `import { type A, type B }` — every specifier inline-`type`, the declaration
  itself not — fabricated a RUNTIME edge and inflated the target's PageRank,
  because after filtering the type specifiers it was indistinguishable from a
  side-effect `import "./x"`. The specifier count separates them. Same shape on
  `export { type X } from`, with the trap reversed: `export * from` also has zero
  named specifiers and IS a real runtime dependency. This is what
  `@typescript-eslint/consistent-type-imports` emits under
  `fixStyle: "inline-type-imports"`, so it is common in the wild.
- [x] **Barrel resolution as the headline.** **DONE — and it was a FIX, not just a
  surfacing.** `d[0]` from `getExportedDeclarations()` is already the checker-resolved
  origin declaration; only its name and kind were read, and its source file — the
  answer to "where is this really defined" — was dropped. Now emitted as
  `definedIn` (or `external: true` for an origin outside the repo; a node_modules
  path is never surfaced). Verified on **radix-ui/primitives@579c5b84**, where
  **62 of 62 `index.ts` files are pure barrels** and 47.2% of imports arrive
  through one.

  The bigger find was underneath: ownership in `callGraph()` read `reExports`,
  built from NAMED specifiers only, so `export * from "./x"` was invisible and a
  pure pass-through barrel was scored as a rival DEFINITION — **one star barrel
  made `--callers` fail the entire query with `error:"ambiguous"`.** That is the
  flagship compiler-accurate command failing hard on the most common barrel form
  in TypeScript, and `test/call-graph.test.mjs` never covered it. A second variant
  followed from the same root: an UNRESOLVABLE re-export (a workspace package with
  no `node_modules` installed) fired neither signal and was likewise counted as a
  definer. Ownership now reads the per-symbol `definedIn`; `reExports` is
  deliberately NOT widened, because `rankSymbols` reads it to discount pass-through
  names and broadening it would have quietly moved symbol ranking.
- [x] **Fix `--callers` on JSX, or make it state its limitation in the payload.**
  **DONE — resolved, not labelled.** JSX elements are now call sites in BOTH
  directions, via one shared `invocationOf()` helper (the filter was duplicated,
  and only the incoming copy was ever reasoned about). Measured on a real React
  repo: `--callers Container` 0 -> 43 call sites. `<Foo>…</Foo>` counts once,
  `<Foo.Bar />` resolves to `Bar`, intrinsic tags fabricate nothing, non-JSX repos
  are byte-identical. This unblocks 1C — the depth positioning could not honestly
  ship while the flagship query lost to `rg`. Original finding:
  ⚠️ **Reproduced in this session** on a 4-file TSX fixture: `--callers Container`
  returns **1** caller (the plain call in `Direct.ts`) and misses **both**
  `<Container>` element usages that `rg '<Container'` finds. That is a shipped
  feature returning under-reported results with exit 0 under a
  "compiler-accurate" label (`mcp.mjs:81`) — the exact silent-degradation class
  this whole document is built to prevent, living inside the feature the depth
  story wants to sell. Either resolve JSX element references, or have `--callers`
  declare the JSX gap in its result payload. **No depth positioning ships before
  this is resolved or labelled.**
- [~] **Extend `eval/eval.mjs` to named public TS monorepos** (pnpm/turbo/nx) and
  kill its third independent extension list at `eval/eval.mjs:54`. PARTIAL — the
  bigger problem found while re-measuring was that the eval **pinned nothing**:
  `git clone --depth 1` took whatever HEAD was that day and merely recorded the
  sha, so a number moving between runs said nothing about whether agentmap or the
  upstream repo had changed. Fixtures are now pinned to full 40-char shas (GitHub
  refuses fetch-by-abbreviated-sha) with a `--repin` escape hatch, and EVAL.md
  states it. Monorepo fixtures and the extension list are still open.

### 1C — Positioning reset (~1 d)

- [x] **Move Quickstart from `README.md:363` to above line 60.** DONE — now at :54,
  directly under the badges. Original finding: A skimming
  evaluator currently passes auto-refresh, PreToolUse hooks, a 7-platform skill
  matrix, the plugin, an onboarding matrix, an *uninstall* section and a
  troubleshooting table before learning how to run it once.
- [x] **Compress `README.md:7–19`** DONE — the 9-line sentence is replaced by one
  line, a runnable command, and a 3-row measured comparison table. Original finding: — a 9-line single sentence front-loading
  ts-morph, tsconfig paths, vite/webpack alias, `#imports` subpaths, workspaces,
  PageRank and two hedged percentages with an inline methodology caveat. The
  problem statement lands and is then buried in resolver trivia.
- [x] **Lead with `--relates` blast radius.** DONE, and the unverified figure was
  NOT used. The flagged "28 vs 48" number stays out of the README entirely —
  instead the headline uses the eval's own **100% precision vs grep's 59.9%**
  (n=42) on zod/zustand/hono, re-measured at 0.16.1 today. Original finding: The baseline competitor is Claude
  Code's own free, zero-install, always-fresh agentic grep — so every claim must
  beat *"just grep"*, and `--relates` is the one that does. ⚠️ The
  "28 precise dependents vs `rg -l`'s 48 hits" figure is **maintainer-measured on
  one repo (nalarx-ace), not re-verified here** — re-measure on a named public
  repo before it goes in the README.
- [x] **Sell depth as fewer wrong files read and fewer tokens burned — never as
  "compiler-grade accuracy."** DONE — the headline is now "Stop your coding agent
  from reading the wrong files", and the old wedge line that led with
  compiler-accuracy is gone. Original reasoning: Accuracy is the axis this market verifiably does
  not price (§2). Token savings is the axis every breakout tool headlines.

### Gate (90 days after Phase 0's working-install release)

**Demand signal — relative, not absolute.** The top-voted language must be
**≥3× the second-place language**, with a floor of **≥8 distinct GitHub
accounts** on the winner; and **≥50% of those accounts (minimum 5)** must
explicitly accept the published capability matrix.

*Why relative:* 25 voters on a 45-star, 0-watcher repo whose observed inbound is
regional rather than category-driven is a bar that would be rationalized past, and
naming that failure mode is not the same as fixing it. A ratio reads a **signal
shape** instead of an audience size this repo does not have.

**Distribution signal — never downloads alone.** Pair every download figure with
an inbound non-security issue count. ⚠️ The 3,266/month baseline was accumulated
by a package that never executed, so the post-fix delta is contaminated by exactly
the traffic that was never a user. Downloads are also bot- and CI-inflated.

### Kill

- Census + vote fails the ratio gate → the original deferral was correct. **Close
  the multi-language question in writing for 12 months** and do not reopen it on
  anecdote.
- The language is requested but the majority reject the degraded matrix → those
  users want CodeGraph or Serena. Serving them means entering at 5th–8th place
  against incumbents with ~115× the distribution. Kill.
- 90 days after Phase 0+1 ship, downloads have not moved **and** inbound
  non-security issues remain ≤2 → distribution was not the bottleneck either.
  Reopen strategy from scratch, including multi-language.
- ≥30% of post-fix inbound requests other languages → the old gate is satisfied
  honestly. Concede and proceed. This is the cleanest possible refutation of the
  deferral and Phase 1A exists to detect it.

---

## ⬜ Phase F — The fidelity contract (precondition, not a phase)

**No non-TS byte is ever indexed until this exists.** The consumer is an LLM that
reads payloads, not READMEs, so the tradeoff must be machine-readable before the
first backend, not documented after it.

- [ ] **Closed `precision` enum** on every `map.json` file entry and every
  `--json` / MCP payload: `compiler` (type-checker-resolved), `resolved` (parsed
  + real import resolution to file paths), `heuristic` (parsed + bare-name
  matching). **State in code and docs that agentmap will NEVER ship a backend at
  `heuristic`.** The value exists so the enum is closed and a future violation is
  a visible diff, not a silent slide. *(This replaces the earlier proposal to ship
  a first backend at that label — a label does not stop the map from being wrong,
  it only documents that it is.)*
- [ ] **One `capabilities` object per backend, read by BOTH surfaces** — the CLI
  dispatch at `agentmap.mjs:2514–2520` and the `TOOLS` registry at
  `mcp.mjs:56–121`. Without a single source of truth, gating gets written twice
  and drifts.
- [ ] **Generate MCP tool descriptions from the matrix.** `mcp.mjs:81` and `:87`
  contain the literal string *"resolved by the TypeScript language service (not
  tree-sitter name-matching)"* — verified. Serving another language through those
  tool names makes the contract false at the point an LLM reads it. Generating the
  description makes that string **physically unemittable** for a non-TS backend.
- [ ] **Hard-refuse, never degrade.** `--callers`/`--calls` on a file whose backend
  lacks the `callGraph` capability exits non-zero **naming the language**; MCP
  returns `isError`. `--features`/`--feature` return an explicit
  `undefined for language: <lang>` instead of `{}` with exit 0 — `featureOf()`
  (`:435–443`) is Next.js App Router-only, so silent emptiness already misreads as
  "this repo has no features" for every Vue/Nuxt/plain-JS user today.
- [ ] **CI assertion: no emitted edge has endpoints owned by different backends.**
  Cheap to write *before* a second backend exists, and it is what makes the
  ~1.96% cross-language mis-wire failure class structurally unreachable.
- [ ] **Extend `SOURCE_EXT` plumbing in the same commit as any backend.**
  `:153–157` feeds `dirtyFiles` (`:243`), `sourceFingerprint` (`:337`) and the
  incremental dirty list (`:1544`). Landing a backend without this means editing a
  `.py` file silently serves a stale map. Correctness landmine, not polish.
- [ ] **Eval discipline as a merge gate.** Every TS/JS number in `EVAL.md`
  unchanged **to the digit** — today: symbol definition top-1/top-3 **50.7% /
  94.7%** (n=75), dependents recall/precision **98% / 100%** (n=42), per-repo table
  at `EVAL.md:78–80` against pinned commits. Plus: **installed package size
  unchanged for TS-only users** (grammars optional and lazily loaded).
- [ ] **Dependency ruling, written down now.** Forbid depending on `tree-sitter-*`
  npm packages outright — each declares `"install": "node-gyp-build"` and ships
  six platforms of prebuilt `.node`; seven languages is ~145 MB unpacked to
  extract ~10.5 MB of wasm, re-importing the exact native surface
  `ROADMAP.md:33` forbids. **Vendor `.wasm` only**, pin the ABI to the
  `web-tree-sitter` runtime (tree-sitter issue #5171: 0.26.x rejects `.wasm` built
  by cli 0.20.x), and evaluate `@vscode/tree-sitter-wasm` (MIT, no install script,
  covers all 7 targets) as the alternative to hand-vendoring.
- [ ] **`pyright` is an offline EVAL oracle, never a runtime dependency** (npm,
  pure JS, MIT, `fsevents` its only optional dep). Ground truth without a ~19 MB
  install-path cost.

---

## ⬜ Phase 2 — Hard-timeboxed throwaway cost spike (Go), never merged

**Goal:** measure the true fixed cost of a second backend and the marginal cost of
the *most favourable* language, so the forever-tax can be priced instead of
guessed. The spike ships nothing. It produces four numbers and a delete-or-proceed
decision.

**Why Go, not Python** (reversing `ROADMAP.md:30`): the spike's job is a **lower
bound**. Go's resolver is a `go.mod` prefix strip plus a directory read; Python's
is a subsystem with permanently unfixable gaps (pyright's own docs concede
`sys.path.append()`, import hooks and `pkgutil.extend_path` are invisible to
static analysis; PEP 420 namespace packages span multiple `sys.path` portions).
If the favourable case blows the box, Python is dead without further argument.
`go list -deps -json` also gives free ground truth.

### Tasks (5 working days, hard box)

- [ ] Build the registry `ROADMAP.md:101` already marks done: per-backend
  descriptor + `backendFor(path)` dispatch, updating all nine `CODE_EXT` consumers
  (`:243`, `:337`, `:862`, `:871`, `:927`, `:940`, `:1041`, `:1341`, `:1544`) plus
  the duplicate ladders at `:674` and `eval/eval.mjs:54`.
- [ ] Make `extractFacts` a dispatcher that fans out per backend and merges facts
  maps, and **export `assemble`** (`:3439` omits it today).
- [ ] Extract the resolver out of the ts-morph closure into
  `resolveSpec(fromDir, spec) -> relKey | null`. **Riskiest single item:**
  `:1050–1132` are closures bound to the live ts-morph `Project`, and it is the
  piece the codebase has zero abstraction for — and the piece a second language
  most needs.
- [ ] Fix the three `assemble()` leaks that falsify its own "knows nothing about
  ts-morph / Vue" comment at `:1280`: the `CODE_EXT_RE` + hardcoded `/\.vue$/`
  strip at `:1341`, `featureOf` at `:1318`/`:1342`, and the stale warning at
  `:1420`.
- [ ] Normalize `kind` at the facts boundary to a declared enum. Today it is raw
  ts-morph `getKindName()` with a trailing `Declaration` regex-stripped at `:1346`,
  so a second backend must fake TypeScript kind names or fragment the lexical index.
- [ ] Author a Go `tags.scm` + a real `go.mod` resolver. **Explicitly do NOT adopt
  Aider's edge model** — `repomap.py` adds an edge from every referencing file to
  every defining file sharing a bare identifier, with no import resolution at all.
- [ ] **Spend 0.5 day desk-checking pyright-as-oracle first.** If it works, the
  per-language resolver cost drops by an order of magnitude and the maintenance
  arithmetic driving every kill criterion below is simply wrong. That must be
  known before, not after.
- [ ] Write down four numbers and stop: hours spent, lines changed/added, Go
  cross-file edge resolution rate on 3 **named** public repos, and whether the
  356-test TS/Vue suite stayed green untouched.

### Gate (end of day 5 — ALL FOUR, or the branch is deleted)

1. Fixed seam cost (registry + dispatch + resolver contract + `assemble` export +
   the three leaks) consumed **≤3 of the 5 days**.
2. Go resolves **≥90%** of cross-file import edges on 3 named public repos against
   `go list -deps -json`.
3. **All 356 existing tests pass with zero changes to TS behaviour.** This is the
   reversibility guarantee — TS/JS is 100% of current value.
4. Total diff **≤1,200 lines**.

### Kill

- Any of the four missed → **delete the branch the same day. Do not extend.** An
  extended timebox is not an experiment, it is a commitment with extra steps.
- The only design that fits the budget is bare-identifier matching → kill
  immediately. Shipping a mis-wired graph under the same CLI as a compiler-exact
  one destroys the one technical claim that is verifiably true, and the trust loss
  is not versioned.
- ⚠️ **Evidence that would defeat the framing, named up front:** if the spike
  lands in ≤3 days at ≥95%, the "expensive commitment" premise collapses and the
  hedge was over-engineered. Record that outcome honestly if it happens.

---

## ⬜ Phase 3 — Ship exactly ONE language, `resolved` tier or not at all

**Runs only if BOTH the Phase 1 and Phase 2 gates passed, and only after Phase F
is green.**

- [ ] Gate the backend behind `AGENTMAP_EXPERIMENTAL_BACKENDS=<lang>`, off by
  default, absent from the main `--help` table (`:2390–2440`). A flag deletes in
  one commit; a documented feature does not.
- [ ] **`precision: "resolved"` is the floor.** Real import resolution to file
  paths. If the backend cannot reach it, **do not ship the language** — a ~70%
  map is the competition's noise profile at a fraction of their reach, and it
  retroactively falsifies every accuracy claim agentmap has made.
- [ ] Bail to a full rebuild rather than extending `buildIncremental` — its guards
  at `:1632–1633` and the five hardcoded ECMAScript regexes at `:1668–1673` would
  be either over-conservative or silently wrong for another language. **Name the
  lost incrementality in the release notes.**
- [ ] Ship the three non-goals *above the fold*, enforced in code: no
  `--callers`/`--calls` (hard-refuse — `:3004–3262` is 259 lines of language
  service, entered directly via `makeProject()` at `:3037`, outside the declared
  seam), no incremental rebuild, no type-inferred receiver resolution.
- [ ] Lead the story with `--search` and `--relates`, never `--callers`.
  `bm25Search` (`:286`) and `splitIdent` (`:273`) are genuinely language-neutral —
  `splitIdent` already handles `snake_case` correctly — so `--search` ports at
  full algorithmic fidelity on day one.
- [ ] Publish the per-language capability matrix as the **first** table in the
  README, above the benchmark numbers. The matrix is the product claim, not a
  caveat.

### Ship gate

Measured **≥95%** cross-file import-edge agreement with the language-native oracle
on ≥3 **named** public repos, denominator disclosed; fidelity-contract tests
green; cross-backend-edge assertion green; `EVAL.md` TS/JS numbers unchanged to
the digit; installed size unchanged for TS-only users.

### Adoption gate (90 days after the experimental release — ALL THREE)

- **(a)** ≥5 distinct external users publicly report real use of the backend.
- **(b)** ≤3 correctness bug reports against the new language's edge graph.
- **(c)** **The TS/JS surface shipped at least one user-visible improvement in the
  same 90 days.**

**(c) overrides (a) and (b).** If the polyglot work consumed all capacity, the
language is killed regardless of how well its own adoption went. That is the
half-finished-polyglot failure mode arriving on schedule, converted from a risk
paragraph into a tripwire.

---

## ⬜ Phase 4 — Promote or delete. Binary, in writing.

- [ ] **PROMOTE:** write the maintenance budget into this file as a hard cap —
  **maximum TWO non-TS languages, ever**, with each additional language requiring
  a feature deleted or a named sponsor. Add the fixture suite to the CI matrix,
  publish per-language coverage in `EVAL.md`, and add a standing check that the
  vendored `.wasm` ABI matches the pinned `web-tree-sitter` version.
- [ ] **DELETE:** one revert commit removing the backend and the flag. **Keep the
  seam** — the registry, dispatch, resolver contract, `assemble` export and the
  three `assemble()` fixes all have standalone TS value: they unblock the still-
  unchecked `lib/` split (`ROADMAP.md:126`) and turn Vue from a 7-touch-point
  pseudo-backend into a first-class one.
- [ ] **DELETE:** publish the post-mortem with the measured numbers. Nobody in this
  category publishes negative results, and a credible "we measured the cost of
  polyglot and declined" is itself distribution.
- [ ] **EITHER:** reallocate freed capacity to Phase 1B's TS/JS depth frontier.

**Gate:** the decision is recorded here with all four Phase 2 numbers and all three
Phase 3 signals **within 2 weeks** of the Phase 3 90-day mark. No third extension,
no "one more language to be sure". **Undecided at week 3 is itself a kill:** the
backend reverts, the seam stays, the post-mortem publishes.

---

## 6. Feature-fidelity matrix — what a non-TS language would and would NOT get

This table determines whether "Python support" is a real product or a
bait-and-switch. It is the product claim, not a caveat. Surface = 13 CLI query
commands + 8 maintenance commands + 11 MCP tools (`agentmap.mjs:2514–2520`,
`mcp.mjs:56–121`).

| Query (CLI / MCP) | TS/JS — `compiler` | Non-TS — `resolved` (the only shippable tier) | Why |
|---|---|---|---|
| `--print`, `--export` | full | **full** | reads the cached map only; no backend involvement |
| `--search` / `search` | full | **full algorithm, corpus-limited** | `bm25Search` `:286` + `splitIdent` `:273` are language-neutral; corpus is `exports`+`locals`, so quality tracks export extraction |
| `--relates` / `relates` | full | **full at tier** | pure edge inversion over resolved imports — the query that ports best; lead with it |
| `--hubs`, `--map`, `--symbols` / `hubs`, `map`, `symbols` | full | **full at tier** | `pagerank` `:469`, `rankSymbols` `:1429`, `identMul` `:514` are language-neutral; quality == resolver quality |
| `--find` / `find` | full | **partial** | TS exports come from `getExportedDeclarations()` `:1164`, which follows barrels *through the checker*. Python's `__all__` is readable by tree-sitter; a transitive re-export chain is not |
| `--any` / `any` | full | **partial + degraded routing** | content rung is `git grep` `:191` (language-agnostic), but the router short-circuits at the first hit (`:3287–3302`), so a thin symbol index returns a thin `[lexical]` answer and never reaches the rung that would have answered |
| `--callers` / `callers` | full (~~lossy on JSX~~ — RESOLVED in 3748c6b) | **NONE — hard refuse** | `:3004–3262` is 259 lines of TS language service (`findReferencesAsNodes` `:3199`/`:3235`) |
| `--calls` / `calls` | full | **NONE — hard refuse** | `getDefinitionNodes` → `getDefinitionAtPosition`; ~48% of call sites are `PropertyAccessExpression` receivers needing type inference (measured over agentmap's own JS — ⚠️ recon-measured, not re-run here) |
| `--features`, `--feature` / `features`, `feature` | Next.js App Router only | **NONE — explicit unsupported** | `featureOf()` `:435–443` matches `app/` route segments only. Today this returns `{}` with exit 0 on every non-Next repo — reads as "no features", not "undefined for your stack" |
| `--include-dts` | TS only | **n/a** | `.d.ts` is a TypeScript file class; the generalization is "declaration-only artifacts" and does not exist |
| incremental rebuild | TS only | **NONE — full rebuild every time** | `:1632–1633` + five hardcoded ECMAScript regexes `:1668–1673` |
| `--doctor`, `--install-hooks`, `--install-skill`, `--hook-status`, `--setup-mcp`, `--mcp`, `--help`, `--version` | full | **full** | no backend involvement |

**MCP tally under any non-TS backend: 0 of 11 tools at TS fidelity — 7 degrade
(`any`, `find`, `search`, `relates`, `map`, `hubs`, `symbols`), 4 must refuse
(`callers`, `calls`, `features`, `feature`).**

Note the asterisk in the TS column: `--callers` is *already* under-reporting on
JSX today. The matrix is not just a promise about future languages — it is a
disclosure about the current one.

---

## 7. Maintenance arithmetic — the number that actually decides this

At ~1 day/week, the maintainer has roughly **45 productive days/year**.

Steady-state per-language tax — grammar ABI re-vendor on every `web-tree-sitter`
major, fixture re-verify, resolver bug tail, eval-corpus upkeep, a per-language
feature-deriver and incremental-hazard predicate — is estimated at
**~2.5–3.5 days/language/year**. ⚠️ **This is an estimate, not a measurement.**
Phase 2's spike exists partly to replace it with a real number, and the
pyright-as-oracle desk-check could invalidate it entirely.

On that estimate:

| Languages | Annual upkeep | Share of all capacity |
|---|---|---|
| 1 | 2.5–3.5 d | 6–8% |
| 2 | 5–7 d | 11–16% |
| 4 | 10–14 d | **22–31%, permanently, before shipping anything new** |

**Two is the honest ceiling for one part-time person.** That cap is why the
9–12-month "build them all properly" path was rejected: it buys acknowledged
parity, on an axis the market verifiably does not price, with no steady-state
budget anywhere in it.

---

## 8. Consolidated kill criteria

1. **Any TS/JS regression, at any phase.** One `EVAL.md` number moves down →
   revert that phase. The existing TS/JS users are the only proven users.
2. **Phase 0's five-way install gate fails or slips past 3 weeks** → stop
   everything.
3. **Phase 1 census fails the 3× ratio / ≥8-account floor** → close the question
   in writing for 12 months.
4. **Phase 1: language requested but the majority reject the degraded matrix** →
   those users want a different product. Kill.
5. **Phase 2: any of the four box conditions missed** → delete the branch same
   day.
6. **Any design that requires bare-identifier matching** → kill immediately,
   permanently.
7. **One cross-backend edge, or one name-matched `--callers` result on a non-TS
   file, in a shipped release** → kill that language. The entire defensibility of
   going polyglot is that the precision labels are TRUE.
8. **Phase 3 gate (c) fails** — no user-visible TS/JS improvement in the same 90
   days → kill the language regardless of its own adoption.
9. **Steady state: non-TS work exceeds ~25% of capacity, or a vendored-wasm
   platform install failure is reported by a user** → stop adding languages at
   whatever count is shipped and harden.
10. **A `web-tree-sitter` major forces an N-grammar re-vendor that does not land
    within 2 weeks** → revert to TS/JS-only rather than shipping a map built on an
    unverified grammar set.
11. **Phase 4 reaches week 3 undecided** → revert the backend, keep the seam,
    publish.
12. **The maintainer's own routing stops using agentmap for structure questions
    across his 8 installed repos.** His private notes already carry carve-outs
    (`--callers` broken on JSX — since RESOLVED in 3748c6b; `--any` unreliable for content because it
    short-circuits at the lexical stage). If the "do not use X" exceptions
    outnumber the "use X" routes, the tool is losing its own maintainer, and no
    roadmap survives that.

---

## 9. Evidence log — what was verified, and how

### Verified first-hand in this session (reproduced, not cited)

- **Guard bug.** `node <symlink> --version` → zero bytes, exit 0; direct
  invocation → `0.16.0`. Probe confirmed both guard arms false under a symlink
  (Node v26.4.0).
- **First broken published version = 0.10.0.** Extracted published tarballs
  0.9.0 → 0.13.0: 0.9.0 has no guard and runs under a symlink (prints `0.9.0`);
  0.10.0 onward carry the guard. `mcp.mjs` has carried it since 0.2.0 (0.1.0
  shipped as `repomap.mjs`, no `mcp.mjs`). **The in-code comment now in the
  working tree says "v0.12.1" — correct it before the deprecate list is written.**
- **`--callers` misses JSX.** ⚠️ **RESOLVED the same day, in 3748c6b** — kept here
  because it is what the measurement found at the time. Post-fix, the same query on
  vercel/ai-chatbot@c2f8235 returns 25 call sites where it returned 0.
  Original finding: 4-file TSX fixture: `--callers Container` → 1 caller
  (`src/Direct.ts`); `rg '<Container'` → 2 files (`Page.tsx`, `Other.tsx`) that
  agentmap does not report.
- **The nudge hook is itself an instance of the bug** — it fired during this
  session recommending `npx @raymondchins/agentmap`, the dead command.
- `test/nudge-hook-grep-symbol.test.mjs:126–136` asserts the broken form and
  forbids the working one.
- `hooks/post-commit:50–72` rung order; rung 1 gated on
  `AGENTMAP_HOOK_ALLOW_LOCAL=1`; detached + silenced at `:84`.
- `.claude-plugin/plugin.json:5` = `0.14.0`; `package.json` / `server.json` =
  `0.16.0`; `README.md:24` badge `>=18` vs `engines >=20`.
- `hooks/INSTALL.md:28` tsconfig prerequisite is false (`agentmap.mjs:823–825`
  documents the glob fallback).
- `agentmap.mjs:1420` vite/webpack warning is false (`:587`, `:642`).
- `degraded` at `:1382` consumed only at `:1419`; `collectMapStatus()` at `:2210`
  never reads it.
- tsconfig `references` absent (only the comment at `:824`); `workspace:` /
  `catalog:` — **zero occurrences** in `agentmap.mjs`.
- `isTypeOnly()` at `:1204`/`:1211`/`:1223`/`:1232`/`:1236` used only to exclude.
- `getExportedDeclarations()` at `:1164` and `:3045`; `callGraph()` at `:3004`
  calls `makeProject()` directly at `:3037`, outside the declared seam.
- `assemble` omitted from the export list at `:3439`; second extension ladder at
  `:674`.
- `.github/workflows/ci.yml:52/:56/:60` — bin path never executed.
- `mcp.mjs:81` and `:87` contain the literal
  "resolved by the TypeScript language service (not tree-sitter name-matching)".
- **Current suite: 356 tests across 92 files; `agentmap.mjs` = 3,446 lines
  (3,470 with the working-tree guard fix).** `ROADMAP.md:11` ("165 tests") and
  `:463` ("~1831 lines") were stale — **both corrected in this same pass**, along
  with the Node ≥18 claim and the competitive north-star note.
- **The guard fix landed while this document was being written** — committed as
  `ae3365e` with `test/bin-symlink.test.mjs` (6 tests, real symlink, asserting on
  output). Suite 356 → 362 green. Phase 0's remaining items are unaffected, and
  **nothing is released yet**.
- **Two language forks exist, not one.** Enumerating
  `GET /repos/raymondchins/agentmap/forks` surfaced `rifanid98/agentmap-go`
  (2026-06-15) alongside the `dstwn/agentmap-php` port found in research.
- **npm, same 30-day window (2026-06-25 → 2026-07-24), re-pulled:** agentmap
  3,266; `scip-query` 4,934. A direct compiler-grade TS competitor out-downloads
  agentmap today.

### Verified by recon (file:line given, not re-run here)

`extractFacts` facts-contract shape and its three undocumented obligations; the
~296-line resolver inventory at `:530–825`; the ~48% PropertyAccess call-site
measurement; the 0-source-files behaviour on a pure-Python repo; the 47-site
TS-coupling sweep.

### External, verified against primary sources

npm downloads over the identical window 2026-06-25 → 2026-07-24 (agentmap 3,266 /
CodeGraph 374,878 / scip-query 4,934 / repomix 313,467); Octoverse 2025 language
and new-repo figures; JetBrains 2025 TS at #4 / 22%; `web-tree-sitter` 0.26.11
(MIT, zero deps, no install script); `tree-sitter-*` npm packages declaring
`"install": "node-gyp-build"`; `@vscode/tree-sitter-wasm` 0.3.1; tree-sitter issue
#5171 ABI mismatch; pyright's npm shape and its own documented resolution limits;
Aider's `repomap.py` bare-identifier edge model and its stall (v0.86.0
2025-08-09, last commit 2026-05-22); CodeGraph issue reaction counts (+36 install
targets, +27 languages, +14 console flash, +0 on each reproduced wrong-edge bug);
`dstwn/agentmap-php` and `rifanid98/agentmap-go` creation dates (re-pulled from the GitHub API).

### ⚠️ Flagged — used with caveats, never as a gate

- **1.96% mis-wire rate (745/38,103).** Self-published by a 44-star adversarial
  competitor, measured on its own repo, README says re-verification pending.
  **Likely, not verified.** Used as illustration of a failure *class*, never as a
  target.
- **CodeGraph's "2–7× faster re-index" and its token/tool-call benchmark figures.**
  Vendor-reported, no independent replication found.
- **arXiv 2603.27277 (83% vs 92% answer quality).** Read from the abstract; the
  full evaluation was not independently reviewed.
- **"28 vs 48" `--relates` precision figure.** Maintainer-measured on one private
  repo. Re-measure on a named public repo before it enters the README.
- **~2.5–3.5 days/language/year maintenance tax.** An estimate. Phase 2 exists
  partly to replace it with a measurement.
- **Star counts across this category.** Systematically inflated (one competitor
  reportedly gained 21,424 stars in a week). Do not use as an adoption proxy
  anywhere in this roadmap.
- **CodeGraph's historical star count at the time `ROADMAP.md:23` was written
  ("~57k").** Not verifiable — the GitHub API exposes only the current value.

### Explicitly excluded

- **"CodeGraph self-reports 95.8% TS coverage" must not become a gate, in any
  form.** It is a vendor figure from a README, on a denominator nobody outside
  CodeGraph has audited, measured against a different repo set. Betting the
  strategy on out-scoring an unaudited number computed a different way is a coin
  flip with a decimal point. It appears here once, as a rejected gate, and nowhere
  else.
- **A fabricated research finding was caught and removed.** During recon, a
  WebFetch summarizer produced a claim that arXiv 2606.22417 showed
  "compiler-accurate approaches significantly outperform tree-sitter." Full-text
  extraction shows the paper contains **zero** occurrences of "compiler", "LSP" or
  "language server", and its own index is tree-sitter-based. That fabricated claim
  would have directly confirmed this roadmap's original thesis. It is recorded
  here so it does not get re-derived.
- **`heuristic` as a shippable precision tier.** Killed. The enum value exists so
  the enum is closed and a violation is a visible diff — nothing more.

---

## 10. What this plan deliberately does not do

- It does not add a language on the strength of the fork, the Octoverse
  percentages, or the competitor issue trackers. Those are reasons to *ask* the
  question, not to answer it.
- It does not spend 9–12 months of a solo maintainer's year buying acknowledged
  parity on an axis the market demonstrably ignores.
- It does not defend the old deferral on its original reasoning. That reasoning
  rested on a gate that could not fire, a seam that was not built, and three
  claims that no longer hold.
- It does not ship telemetry, and therefore accepts that every gate here is a
  lagging proxy with wide error bars. The bars are stated so they are not
  quietly rationalized away later.

**The one-sentence version:** the majority cannot run it at all, so language
coverage is a question that cannot be asked until the denominator is non-zero —
fix the binary, spend the waiting window making TS/JS undeniable, buy the
multi-language option for about seven working days, and let a measured signal, not
an instinct, decide whether it is ever exercised.