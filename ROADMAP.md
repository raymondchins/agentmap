# agentmap — Improvement Roadmap

> Working plan derived from a full multi-agent audit (2026-07-03): 7 code-audit
> dimensions + 3 web-research reports, every finding adversarially verified.
> This doc is the pick-up-anywhere backlog — each task carries a `file:line`
> anchor, the fix approach, and a checkbox. Check items off as you land them.
>
> **How to use:** work the batches top-to-bottom (they're ordered by
> effort-vs-impact and dependency). Batch 2 is the structural enabler for 3 and
> 5 — do it before them. Within a batch, land one commit per logical fix with a
> regression test, and keep `npm test` green (currently **165 tests**).

---

## Strategic decision: multi-language support

**Question raised:** should agentmap move beyond TS/JS (adopt Python/Go/Rust…)?

**Answer: build the seam now, defer the languages.** The two research reports
deliberately disagreed, and the reconciliation is:

- **Competitive report:** multi-language via tree-sitter is the kill-zone of
  **CodeGraph** (launched Jan 2026, ~57k stars, 20+ languages, 2s auto-sync,
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
| **2** | Modularize for testability + backend seam | 2–4 d | 🔨 in progress — 4/8 (all *high* + de-dup done, verified byte-identical) |
| **3** | Dirty-tree performance | 3–5 d | ⬜ |
| **4** | Distribution & release hygiene | 2–3 d | ⬜ |
| **5** | TS-depth before language-breadth | weeks | ⬜ |
| **B** | Cross-cutting backlog (low-severity) | ongoing | ⬜ |

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
- [ ] **Declarative command table** — `agentmap.mjs:1602`: flag parsing is
  order-insensitive set membership, so orphan sub-flags (`--focus` without
  `--map`) and conflicting commands are silently accepted. Add a post-parse
  validation pass (exactly one command; each sub-flag declares its parent; exit 2
  on violation). *(architecture/medium)*
- [ ] **Unify writer/checker pairs** — `agentmap.mjs:1142`: `setupMcp` vs
  `MCP_TARGETS`, `installHooks` vs `collectHookStatus` duplicate targets/predicates
  kept in sync only by comments. Hoist one shared TARGETS/PREDICATES structure per
  pair. *(architecture/medium)*
- [ ] **Exit-code contract** — `agentmap.mjs:1724`: `--map --focus` with no match
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

### Tasks

- [ ] **Dirty-map caching / incremental invalidation** — `agentmap.mjs:806`:
  `ensureFresh()` rebuilds from scratch whenever the tree is dirty. Minimum:
  cache a dirty-built map keyed by a fingerprint of the dirty file set
  (`path:mtime:size`, like the existing non-git `sourceFingerprint`) so
  back-to-back queries reuse one rebuild. Goal: keep the clean-HEAD map, re-parse
  only the files `git status` reports changed, patch their nodes/edges, re-run
  PageRank (cheap, ~100ms at 5k files). *(performance/high)*
- [ ] **Build wall-clock budget + visible skips** — `agentmap.mjs:638`: deep
  import chains cause superlinear blowup (16+ min at 5k files) with files silently
  dropped via stack overflow. Add a time budget (degrade to a partial map marked
  `incomplete`), count + surface skipped files in the map/summary (not stderr
  only), and prefer the iterative hand-rolled `resolveSpec`/`tryResolveAt` over
  ts-morph's `getModuleSpecifierSourceFile` for the edge pass. *(performance/high)*
- [ ] **Incremental post-commit rebuild + lock** — `hooks/post-commit:67`: the
  hook re-parses the entire repo on every commit and concurrent rebuilds duplicate
  work with no locking. Diff `HEAD~1..HEAD` and re-parse only changed files + their
  direct dependents; add a lockfile / compare-and-skip on in-progress HEAD build.
  *(performance/medium — depends on Batch 2 incremental machinery)*
- [ ] **Memory ceiling** — `agentmap.mjs:563`: whole-repo ts-morph AST held in RAM
  (~90KB/file → ~443MB at 5k files). Process in batches and forget consumed ASTs
  (`project.removeSourceFile` / `forgetNodesCreatedInBlock`) since `build()` only
  needs per-file exports/imports; warn near heap limits; document a file-count
  envelope. *(performance/medium)*
- [ ] **Cap unbounded symbol matches** — `agentmap.mjs:1667`: a broad
  `--find`/`--any` emits ~93k tokens on a 5k-file repo, defeating the whole point.
  Cap results (e.g. 50, like `CONTENT_LINES_LIMIT`) ranked by PageRank, with a
  "showing N of M — narrow your query" footer in prose + JSON. *(performance/medium)*
- [ ] **Prune rankSymbols cross-product** — `agentmap.mjs:736`: refs×defs edge
  list per identifier is quadratic on duplicated export names. Skip identifiers
  whose definer count exceeds a threshold (near-zero signal after the 0.1
  multiplier) or aggregate into per-defFile summary edges. *(performance/low)*

**Acceptance:** a second query on an unchanged dirty tree does not re-parse;
a pathological deep-chain repo finishes within the budget with skipped files
reported; `npm test` green + a concurrency test (see Batch B).

---

## ⬜ Batch 4 — Distribution & release hygiene

**Goal:** fix the "near-zero market footprint" problem (agentmap doesn't surface
in searches for its own category, and an unrelated `agentmap` npm package collides
with the name). Near-zero code; sequence *after* Batches 1–3 so what gets
discovered is trustworthy and fast.

### Distribution (from the agent-ecosystem research)
- [ ] **Claude Code plugin + marketplace** — add `.claude-plugin/plugin.json`
  bundling the PreToolUse nudge hook (via `${CLAUDE_PLUGIN_ROOT}`), SKILL.md, and
  the stdio MCP server; add `.claude-plugin/marketplace.json` so
  `/plugin marketplace add raymondchins/agentmap` works; submit to
  `anthropics/claude-plugins-official`. (Plugins can't install git hooks — keep a
  SessionStart hook or `--install-hooks` for the post-commit refresh.)
- [ ] **Official MCP Registry listing** — add `mcpName: "io.github.raymondchins/agentmap"`
  to `package.json`, run `mcp-publisher init && login github && publish`. Low
  effort (package already on npm); feeds Smithery/mcp.so/PulseMCP.
- [ ] **`npx skills add` compatibility** — align repo layout so
  `npx skills add raymondchins/agentmap` works (already ships SKILL.md); gets on
  the skills.sh leaderboard, distributes across Claude/Cursor/Codex at once.
- [ ] **Codex CLI PreToolUse hook** — biggest enforcement gap; extend
  `--install-hooks` to write a `hooks.json`/`config.toml` PreToolUse matcher
  returning `permissionDecision: deny` + reason (do NOT use `additionalContext` —
  Codex fails open on it). **Guard:** a hard `deny` on grep must carry an
  allow-fallback (non-source paths, map-build-failed, repeat query) or it'll drive
  uninstalls — agentmap only covers TS/JS/Vue. Same pattern for Copilot CLI.
- [ ] **Cursor `hooks.json` + Gemini CLI extension** — upgrade Cursor from
  rule+MCP to a `beforeShellExecution` hook redirecting grep/rg to agentmap;
  package a Gemini extension (`hooks.json` + GEMINI.md + MCP) for the gallery.

### Release engineering (from the completeness critic — uncovered dimension)
- [ ] **Git tags + tag-triggered publish workflow** with `npm publish --provenance`
  (repo has zero tags, zero GitHub Releases, no publish workflow).
- [ ] **Release automation** (release-please / changesets) — structurally fixes
  the recurring missing-CHANGELOG-entry problem (and the lockfile-version drift
  just seen in `aa62353`).
- [ ] **README trust markers** — state "fully local, no network, no telemetry"
  (verified: zero `fetch`/`http` in `agentmap.mjs`) — a free differentiator vs
  cloud/embedding indexers. Add a name-collision note (`npx agentmap` runs an
  unrelated package; always use the scoped `@raymondchins/agentmap`).
- [ ] **Fix the Gemini nudge (functional bug, do here or Batch B)** —
  `hooks/agentmap-gemini-nudge.mjs:59`: BeforeTool doesn't support
  `additionalContext`, so the nudge is silently dropped. Move to AfterTool
  `additionalContext` or BeforeTool `systemMessage`; update
  `install-helpers.mjs`. *(correctness-integrations/high)*

**Acceptance:** `npx skills add` works; MCP Registry + plugin marketplace entries
live; a tagged release publishes with provenance; README states the privacy
posture and the name-collision caveat.

---

## ⬜ Batch 5 — TS-depth before language-breadth (the long bet)

**Goal:** become the *definitively best* TS/JS context tool. Deepen the ts-morph
moat rather than diluting it. Revisit tree-sitter multi-language only if
post-distribution demand asks for Python (Batch 2's seam makes it a 1–2 week add).

### Correctness prerequisites for credible monorepo claims
- [ ] **tsconfig `extends` baseUrl/paths origin bug** — `agentmap.mjs:314`:
  inherited `baseUrl`/`paths` resolve relative to the *child* config dir, not
  where they originate → monorepo alias edges silently dropped. Resolve targets to
  absolute against `dirname(cfgPath)` at read time before merging. *(correctness/high)*
- [ ] **Longest-prefix alias rule** — `agentmap.mjs:520`: uses first-listed
  `paths` pattern instead of TS's longest-prefix-wins → edges can point at the
  wrong file. Sort aliasEntries by descending prefix length, exact patterns first.
  *(correctness/medium)*
- [ ] **tsconfig edits invalidate cache** — `agentmap.mjs:101`: uncommitted
  `tsconfig.json`/`jsconfig.json` edits never bust the cache → stale import edges.
  Add `(^|/)(tsconfig|jsconfig)(\..*)?\.json` to the `dirtyCount` filter (or hash
  alias configs into freshness). *(correctness/medium)*
- [ ] **`git mv` to non-source staleness** — `agentmap.mjs:99`: `dirtyCount` tests
  only the NEW path of a rename; test both sides. *(correctness/medium)*
- [ ] **Non-ASCII filenames** — `agentmap.mjs:411`: git ls-files C-quoting defeats
  the extension check → those files vanish from the map. Use
  `-c core.quotePath=off` or `-z` + NUL split. *(correctness/medium)*
- [ ] **`resolveFile` prototype pollution** — `agentmap.mjs:827`: `--any constructor`
  / `--relates toString` crash (prose) or fabricate a hit (JSON/MCP). Use
  `Object.hasOwn` / `Object.create(null)` maps. *(correctness/medium)*

### Resolution gaps beyond tsconfig (uncovered — needed for monorepo depth)
- [ ] `package.json` `"imports"` subpath maps (`#internal/*`) — currently only
  matched against tsconfig aliases.
- [ ] `vite.config` / webpack `resolve.alias` (zero support today).
- [ ] Workspace cross-package resolution (`import '@org/pkg'` → `packages/pkg/src`
  via pnpm/npm workspaces).

### The depth features (competitive bets #1 and #4)
- [ ] **Compiler-accurate call graph** — use ts-morph's language-service reference
  finding to add call-site edges + symbol-level blast radius. Market head-to-head
  vs tree-sitter noise ("the only repo map whose TS call graph comes from the
  actual compiler"). Accept build cost via lazy per-file reference resolution.
- [ ] **Monorepo/framework intelligence** — first-class pnpm/turborepo/nx (per-package
  maps, cross-package edges), React server/client boundaries, tRPC routers, Prisma
  schema links, barrel-file flattening. Add a CI-buildable, compressed,
  team-shareable map artifact.
- [ ] **Hybrid lexical retrieval without embeddings** (bet #5) — a pure-JS BM25/FTS
  stage fused with the PageRank symbol graph for vague NL queries; real tokenizer
  budgets (tiktoken-style) replacing chars/4. Keeps the no-vector-DB positioning.

### User-configurable scoping (predictable first GitHub issue)
- [ ] **`.agentmapignore` / config** — skip-list is hardcoded to
  `node_modules/.git/.next` (`agentmap.mjs:124,413,435,487`); no exclude/include
  globs, no extra-extension hook. `SRC_EXT` (`:113`) also indexes `.d.ts` generated
  declarations. Add a config file / `package.json` key / `--exclude` globs.

### Deferred (do NOT do yet)
- [ ] Tree-sitter multi-language tier (Python → Go → Java via `web-tree-sitter` +
  `tags.scm`). Gate on real demand. See *Strategic decision* above.

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
- [ ] **Concurrency + e2e hook tests** — `test/helpers.mjs:48`: no parallel-build
  race test; the shipped post-commit hook never runs e2e. Add both (parallel
  `--find` on a dirty repo → valid JSON; `--install-hooks` without the hooksPath
  override → commit → `generatedSha === HEAD`). *(tests/medium)*
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
- [ ] **Claude nudge npx path** — `hooks/agentmap-nudge.mjs:116` tells the agent to
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
- [ ] Node 18 is past EOL (Apr 2025) but in `engines` + CI matrix — decide support
  policy. No `dependabot.yml`/renovate; `ts-morph` exact-pinned with no update path.
- [ ] Community health files: no `.github/ISSUE_TEMPLATE`, PR template,
  `CODE_OF_CONDUCT.md`, `FUNDING.yml`. CI Actions pinned by mutable tags (`@v5`),
  not SHA — a hardening gap the SECURITY.md advertises.
- [ ] Consider a neutral `.agentmap/` cache path (currently `.claude/agentmap/`
  even for Gemini/Codex/Cursor users) with back-compat.
- [ ] `--export dot|mermaid` graph export (the data exists in `map.json`) — cheap
  ask + marketing demo surface.

---

## References

- **Full audit report** (52 confirmed findings with evidence, 3 research reports
  with source URLs, completeness critique, contradictions) — generated
  2026-07-03. Ask Claude to regenerate from the workflow run, or see the session
  where this roadmap was created.
- **Key numbers:** the tool is a single-file CLI (`agentmap.mjs`, ~1831 lines),
  one runtime dep (`ts-morph`), Node ≥18, currently **165 tests** green.
- **Competitive north star:** CodeGraph (multi-language, 57k stars) owns breadth;
  agentmap wins on ts-morph compiler accuracy + honest eval + agent-loop wiring.
  Don't chase breadth; deepen TS.
