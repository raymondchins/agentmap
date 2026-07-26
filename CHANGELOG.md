# Changelog

All notable changes to agentmap are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **`new Foo()` was not a call site.** `invocationOf()` matched only
  `CallExpression`, never `NewExpression`, so a class reachable ONLY via `new`
  reported **zero callers** — silently, exit 1, indistinguishable from genuinely
  unused. Two lines, but the blast radius was the whole class of
  instantiated-not-invoked symbols, and it hit the transitive `--depth >= 2` path
  too since that shares the predicate. Found by diffing the live walk against the
  new call-edge sweep, which had swept `NewExpression` all along.

- **A symbol exported under a different name than its declaration was invisible to
  the cached path.** `export { impl as Widget }` binds the export to `Widget` while
  the node stays named `impl`; the sidecar keyed edges on the declaration's own
  name, but queries resolve by the EXPORTED name, so `--callers Widget` returned 0
  from cache and 1 live. Edges now carry every name the defining file exports a
  declaration as, read from the same `getExportedDeclarations()` the query resolves
  through.

- **A reassigned local alias fabricated a call.** For `const wrapped = helper;
  wrapped()`, go-to-definition walks through the trivial reassignment and returns
  BOTH the local binding and `helper`. The sweep emitted an edge for each, crediting
  `helper` with a call site that never names it — the live reference walk reports
  none. Resolution now stops at a local value binding when one is among the targets.

### Known
- A barrel that BOTH `export * from "./a"` and locally redefines the same name is
  the one shape where the cached and live paths still disagree — and the cache is
  the correct one. ES semantics say the local binding shadows the star-export, so
  `a.ts`'s copy is unreachable; the sweep agrees (0 callers) while
  `findReferencesAsNodes()` over-reports through the star chain (1). Left as-is
  rather than teaching the cache to reproduce a wrong answer.

### Added
- **`--build-edges`: a precomputed call-edge index, so `--callers` stops paying the
  type-checker on every query.** `--callers` was ~1500ms and the reason was not the
  reference search — profiling put ~750-860ms, about half the total, in the FIRST
  touch of the type-checker (`getExportedDeclarations()` forcing a full-program
  bind), a cost that is nearly fixed: a 2-reference symbol pays the same as a
  119-reference one, and scoping the ts-morph Project to a file's known dependents
  (251 files -> 50) cut it only ~24%, because the bulk is binding `lib.d.ts` and
  `@types`, not your code.

  So the checker work moves off the query path entirely. `--build-edges` sweeps
  every file once, resolves each call/JSX site through the same go-to-definition
  primitive the live walk uses, and writes `.claude/agentmap/calledges.json`.
  `--callers` then answers from that file: **1514ms -> 77ms** on a 252-file repo,
  verified byte-identical to the live walk across 12 symbols there (including `cn`
  at 119 call sites, and both definitions of an ambiguous `ToggleSwitch`).

  It is a cache, never a second source of truth. The sidecar is keyed to the exact
  map it was derived from — HEAD, dirty fingerprint, schema — so an edit invalidates
  it and the query silently falls back to the live walk. Corrupt file, missing file,
  `--depth >= 2` (which needs findReferences-able nodes a JSON row cannot carry),
  and `--calls` (different output shape) all fall back the same way. There is no
  configuration in which a stale sidecar is served.

  Building it costs ~4x a map rebuild (~9s on 252 files) and that is irreducible:
  the per-site `getDefinitionNodes()` call is 89-94% of it, and a prefilter that
  skips candidates absent from a file's declared/imported names drops 35-44% of real
  edges, because React code overwhelmingly calls names bound at nested scope
  (destructured hook state, nested helpers). A correct prefilter only recovers
  ~25-35% of the cost. So the step is explicit, never implicit: the post-commit hook
  runs it detached, lock-guarded and timeout-capped, where nothing waits on it.
  `AGENTMAP_HOOK_EDGES=0` skips it. `--relates`/`--find`/`--hubs`/`--map` never read
  or write it and are unchanged.

### Fixed
- **`<Foo.Bar />` was never a call site — the whole branch was dead code since 0.17.0.**
  `invocationOf()` reached for the tag holder with
  `id.getParentIfKind(SyntaxKind.JsxMemberExpression)`, but **TypeScript has no
  `JsxMemberExpression` SyntaxKind** — that is a Babel/ESTree node type, so the
  lookup read `undefined` off the enum, `getParentIfKind(undefined)` never matched,
  and `tagHolder` fell back to the bare identifier. `getTagNameNode()` returns the
  member expression, so the identity check failed and every dotted tag was dropped.
  TypeScript models a dotted JSX tag name as a plain `PropertyAccessExpression`,
  which the function already computes one line earlier as `pa`. Now `tagHolder =
  pa ?? id`. `import * as UI from "./widget"` + `<UI.Widget />` is found;
  `--callers` on a namespace-imported component went 10 → 11 sites on the JSX
  fixture, with no change to any other pattern.

  Still not resolved (a ts-morph limitation, not this bug): aliasing a component
  through an object literal — `const UI = { Widget }` then `<UI.Widget />`.
  `findReferences` returns only the import and the shorthand property for that
  file, never the render site.

- **Call sites inside anonymous callbacks reported `<module>` instead of the
  component that owns them.** The enclosing-scope lookup stopped at the *first*
  function ancestor. For `{items.map(x => <Row key={x.id} />)}` that ancestor is the
  anonymous `.map()` arrow, which has no name and is not the initializer of a
  variable declaration — so the caller degraded to `<module>` even though a named
  component plainly encloses it. Same for IIFEs and `startTransition(async () => …)`.
  Measured on two real React repos: **11 of 43** JSX call sites in one, **6 of 95**
  across another, all in this one shape; the non-JSX control had zero.

  `enclosing()` now walks *outward* through anonymous ancestors until a named owner
  appears (variable-declared arrow/function expression, object-literal property,
  named function expression, function/method/class declaration), and is hoisted so
  the single-hop `--callers` path shares it with the transitive `--depth > 1` path
  instead of keeping a weaker copy. `<module>` now means genuinely top-level rather
  than "wrapped in a callback". Across 65 call sites in two repos: **0 remaining
  `<module>`**, recall unchanged.

- **A file that failed to parse vanished from the map, and the map said nothing.**
  Per-file parse errors are caught so one bad file cannot abort the build — correct,
  and unchanged. But the file never reached `files[path]`, so `map.json` reported a
  `fileCount` over the **survivors** with `degraded: false` and exit 0, while
  `--relates` / `--find` / `--hubs` answered confidently about a graph the file had
  never been in. The only trace was one stderr line that scrolls away.
  Reproduced on 0.18.1: a 4-file repo with one bad module specifier produced
  `fileCount: 3`, `degraded: false`, exit 0 — and seeded `facts.json` from the
  truncated build, so later dirty queries would inherit the missing file as a
  permanent absence.

  Skips are now recorded and surfaced: `incomplete`, `skippedCount`, `skipped`
  (capped at 100, with `skippedTruncated`) in `map.json`; a `⚠ INCOMPLETE map: N of
  M files were not indexed` line on stderr; a `status: "incomplete"` check in
  `--doctor` that names the files and flips `overall` off `ok`. A truncated build no
  longer writes the Tier-2 facts snapshot. Stack-overflow skips are classified apart
  from parse errors — those come from `getExportedDeclarations()` recursing through
  very deep `export * from` barrel chains, where the fix is to flatten the chain, not
  fix a typo.

  Every field is spread conditionally, so a repo that indexes every file serialises
  **byte-identically to schema 6** — asserted by a test. `map.dirty.json` is
  unaffected (same `target === MAP` gate as `edgeCoverage`).

### Changed
- **`SCHEMA_VERSION` 6 → 7**, forcing a one-time cache rebuild. Deliberate: a
  `map.json` written before this change may *already* be missing files with no way to
  tell, and without the bump it would keep being served until HEAD happened to move.
- **Two concurrent queries on one repo could hard-crash one of them.**
  `assemble()` wrote its output through a FIXED tmp name — `map.json.tmp`,
  `map.dirty.json.tmp`, `facts.json.tmp` — i.e. the same literal path in every
  process. Nothing on the CLI/MCP query path holds a lock (`hooks/post-commit`
  has one, but only for its own invocations), so two agent sessions querying the
  same repo on a dirty or freshly-committed tree both reach the write. The winner
  renames the shared tmp away and the loser's `renameSync` throws an uncaught
  `ENOENT: … rename '.claude/agentmap/map.json.tmp'`, which propagates out of
  `assemble()` → `build()` → `ensureFresh()` → `main()`. There is no top-level
  catch, so the query dies with a stack trace. Measured pre-fix: **2 of 18**
  processes across 3 rounds of 6 concurrent queries on a 150-file repo; **7 of 8**
  per round under a synchronized barrier.

  Tmp names are now per-writer (`<target>.<pid>.tmp`). `renameSync` stays atomic
  per writer and the last rename to land still wins — the same "last build wins"
  outcome as before, minus the crash. The `facts.json` sibling write had the same
  shared path; it sits inside a catch-all, so instead of crashing it silently lost
  the Tier-2 snapshot and made the next dirty query re-parse the whole repo for no
  visible reason.

  Scope note: **torn/interleaved JSON was the hypothesised failure and did not
  reproduce** — 0 tears across 8 synthetic rounds at 6MB and 96MB payloads and
  every real-repo round. The crash is the actual defect. Post-fix: 0 crashes in 36
  concurrent processes. Regression coverage in `test/concurrent-build.test.mjs` —
  one timing-free test that occupies the legacy shared tmp paths with directories
  (pre-fix: `EISDIR`, exit 1) plus a 6-way concurrency smoke test.

## [0.18.1] - 2026-07-26

### Fixed
- **One duplicated `extends` entry could spin a core forever.**
  `readTsconfigAliasOpts` had no memo and no visited set, so `extends` resolution
  fanned out as `branch^depth`. The `_depth < 10` cap bounds *depth*, not *work*:
  since TS 5.0 `extends` may be an **array**, so each level multiplies. A single
  self-referencing file — `extends: ["./tsconfig.json", ×4]` — is 4¹⁰
  `readFileSync` + `JSON.parse` calls, and a diamond or a cycle never dedupes.

  Because it is a synchronous loop the process never reaches a signal handler, so
  `SIGTERM` is ignored and only `SIGKILL` stops it — which is what made it look
  like an unkillable runaway rather than a slow build. Attribution was confirmed by
  stack-sampling a hung run: `v8::internal::JsonParser` and
  `node::fs::ReadFileUtf8` dominate, and TypeScript uses its own scanner rather
  than `JSON.parse`, so the frames are agentmap's own.

  Each config is now read at most once per top-level call, with the in-flight
  `null` doubling as the cycle guard. `_memo` defaults to a fresh `Map` per
  top-level call, so every acyclic, non-duplicated config — i.e. every real repo —
  behaves byte-identically. Isolated repro: **25s-then-SIGKILL → 0.3s**.

  Known limit, upstream and out of scope: an **acyclic** deep chain (6 wide × 9
  levels of distinct files) still hangs, because TypeScript itself is exponential
  there. A pure ts-morph probe with no agentmap involved goes 0.4s at `fanout=2`,
  13.1s at `fanout=4`, SIGKILL at `fanout=6`.
- **The post-commit hook's timeout killed the wrapper, not the process it
  wrapped.** 0.18.0 put the backgrounded rebuild under a single-instance lock and
  a 120s watchdog, but the watchdog signalled only the pid it backgrounded. When
  the runner resolves to fallback #4, `npx --no-install @raymondchins/agentmap`,
  that pid is the npx wrapper and the real work is a child `node
  .../bin/agentmap` — so the wrapper died on schedule and the child was reparented
  to init, still spinning a full core with nothing left to reap it. The lock
  stopped orphans *stacking*; this is why one could still be created at all.

  Process groups cannot carry this. The first attempt used `set -m` so the
  background job would land in its own group and `kill -- -$_am_pid` would reach
  everything under it — that works under bash but **not under dash**, Ubuntu's
  `/bin/sh`, which leaves the job in the invoking shell's group even with job
  control on (measured: pid 33422, pgid 33387). There the group kill either fails
  or, worse, would signal the hook and `git` along with it. The regression test
  below caught exactly that on Linux CI while passing on macOS.

  The timeout now walks the process tree with `pgrep -P` instead, which needs no
  controlling terminal and behaves identically on both shells. The tree is
  collected deepest-first so children are signalled before their parents, and
  snapshotted *before* signalling — once the wrapper dies its children are
  reparented to init and `pgrep -P` can no longer find them. SIGTERM first so a
  healthy run can flush, SIGKILL after a grace period. Where `pgrep` is absent
  (Git for Windows) the walk yields just the one pid and this degrades to the old
  single-pid behaviour rather than erroring.

  Measured on the machine where this surfaced: **~30 W per orphan**, three at once
  drawing **114.5 W** with the battery falling 2%/min, against a 23.4 W baseline
  with the same applications open. Now covered by a fifth regression test in
  `test/post-commit-hook.test.mjs` that drives a wrapper-plus-grandchild runner
  and asserts a heartbeat file goes stale; it fails against the single-pid form, and it is what caught the dash gap above.

- **The test suite leaked the MCP server it spawned.** `mcpCalls()` and `rpc()`
  start a long-running `agentmap --mcp` over stdio but called `child.kill()` only
  in the happy-path callback — the timeout-reject and `child.on("error")` branches
  abandoned it. A live piped child keeps the event loop alive, so the run hung
  until killed externally, at which point the child became an orphan burning a
  core. `helpers.mjs`'s fixture cleanup ran only on `"exit"`, which never fires on
  SIGTERM/SIGKILL, so `agentmap-test-*` dirs accumulated down the same path
  (427 MB observed).

  `helpers.mjs` now owns `trackChild()`/`killChild()` (SIGTERM, SIGKILL after a 2s
  grace) with a `_children` registry wired into the exit backstop and `SIGINT`/
  `SIGTERM` handlers, plus a 60s `CHILD_TIMEOUT_MS` ceiling; both MCP suites kill
  on every settle path. Direct `execFileSync`/`spawnSync` calls in seven suites
  that bypassed the helper gained timeouts, and `runWithHome()` — previously
  copy-pasted into three suites without one — is now shared.

  Neither leak is reachable from the published CLI: both live in the test harness
  and the hook's watchdog, so no user-facing behaviour changed.

## [0.18.0] - 2026-07-26

Map `SCHEMA_VERSION` bumped **5 → 6** (adds per-export `definedIn`/`external` and
per-file `typeOnlyImports`/`typeOnlyDependents`); caches rebuild once on upgrade.
Every new field is emitted only when it carries information, so a repo with no
barrels and no type-only imports serialises byte-identically to schema 5.

**Cost, measured rather than asserted.** Build and query time are unchanged: every
cold-build delta across three pinned repos fell inside a 7–15% run-to-run noise
floor with the sign flipping repo to repo, and peak RSS moved +0.49% against its
own 0.72% spread. The barrel work is genuinely free at build time because
`getExportedDeclarations()` already materialises the declaration node. The
fast-path invariant holds — `--relates` still never constructs a Project, verified
across 30 warm runs with zero reparses. What does grow is the map on disk, and on
barrel-heavy repos it is not negligible: `map.json` **+1.8% to +6.0%**,
`facts.json` **+2.6% to +17.0%** (chatbot / primitives / headlessui).

### Added
- **The real definition site behind a re-export barrel.** `getExportedDeclarations()`
  already walks barrel chains through the type checker, so the origin declaration
  was being materialised on every build and then discarded. It is now kept: an
  export reached through a barrel carries `definedIn` (the file that actually
  declares it, through any number of hops) or `external: true` when the origin
  lies outside the repo. `--find`, `--any` and `--relates` all surface it, in JSON
  and in prose, so "which file do I actually edit?" has an answer instead of two
  undifferentiated hits.

  On **radix-ui/primitives@579c5b84**, where **62 of 62 `index.ts` files are pure
  re-export barrels** and 47.2% of imports arrive through one:

  ```
  packages/react/primitive/src/index.ts → Primitive (VariableDeclaration) → defined in packages/react/primitive/src/primitive.tsx
  packages/react/primitive/src/primitive.tsx → Primitive (VariableDeclaration)
  ```

  A node_modules path is never emitted — the graph holds no node there, so a
  dependency origin reports `external: true` and nothing else.

- **Type-only edges, kept out of the runtime graph but no longer discarded.**
  `import type { T } from "./x"` was skipped outright, correctly reasoning that a
  type import has no runtime existence and must not inflate PageRank. The cost was
  invisible: the imported file's `dependents` came back **empty**, so a file every
  consumer depends on read exactly like an orphan. On
  **vercel/chatbot@c2f8235e**, `lib/types.ts` has 23 importers, all 23 type-only,
  and `--relates` reported `dependents (0): —`. It now reports all 23 under
  `typeOnlyDependents`, while `dependents` keeps meaning "breaks at runtime".
  22.4% of that repo's import statements are type-only.

  `imports`/`dependents`, PageRank, `edgeCoverage`, symbol ranking and
  `--export dot|mermaid` are all deliberately unchanged — the new fields are
  disjoint from `imports` and never enter the ranking graph.

### Fixed
- **One `export *` barrel made `--callers` refuse the whole query.** Ownership
  ("which file DEFINES this symbol") read `reExports`, which is built only from
  NAMED export specifiers — `export * from "./x"` has none to iterate, so a pure
  pass-through barrel was scored as a competing DEFINITION and the flagship
  compiler-accurate command returned `error: "ambiguous"` rather than an answer.
  `export *` is the most common barrel form in TypeScript. Reproduced before the
  fix: `--callers Thing` → `candidates: ["src/mid.ts","src/thing.ts"]`, where
  `src/mid.ts` contains nothing but `export * from "./thing"`.

  Ownership now reads the per-symbol `definedIn`/`external`, which the checker
  resolved. `reExports` itself is deliberately **not** widened: `rankSymbols`
  reads it to discount pass-through names, so broadening it would have quietly
  moved symbol ranking.

- **An import whose specifiers were all inline-`type` fabricated a runtime edge.**
  `import { type A, type B } from "./x"` emits nothing at all, but filtering the
  type specifiers left an empty name list, which the edge builder could not
  distinguish from a side-effect `import "./x"` — which does run. It fell through
  to the `["*"]` fallback, created a runtime dependency that does not exist, and
  inflated the target's PageRank. The specifier *count* is what separates the two
  cases. Same bug on `export { type X } from "./z"`, where `export * from "./z"`
  also has zero named specifiers but IS a real runtime dependency. This shape is
  what `@typescript-eslint/consistent-type-imports` writes under
  `fixStyle: "inline-type-imports"`, so it is common. Predates this release;
  found by an adversarial pass over the type-only work above.

- **An unresolvable re-export was scored as a definition.** Found on
  radix-ui/primitives: `export { useComposedRefs } from '@radix-ui/react-compose-refs'`
  in a workspace with no `node_modules` installed resolves to nothing, so neither
  signal fired and the forwarding file was counted as a definer. Whether a
  specifier resolves is a fact about the environment; whether the syntax declares
  a name is not. A bare `export { local }` (no `from`) is unaffected — it does
  declare, and is still treated as a definition.

- **`exports` subpath patterns formed no edge at all.** `"./wild/*": "./src/wild/*.ts"`
  was looked up by exact key only, so every wildcard subpath in a workspace
  package silently produced nothing — exit 0, no warning. Node's pattern rules now
  apply, checked against a real Node v26 rather than a reading of the docs:
  longest prefix before the `*` wins, and on a tie the longer FULL key wins
  (declaration order never decides — Node's own docs pair `"./lib/*"` with
  `"./lib/*.js"`, where ordering by key resolves to the wrong file). A pattern
  whose wildcard would match the empty string is rejected, because Node raises
  `ERR_PACKAGE_PATH_NOT_EXPORTED` there and claiming otherwise would invent an
  edge for an import that throws.

- **Nested `exports` conditions resolved to nothing.** `{"node": {"import": "./src/x.ts"}}`
  was read one level deep and abandoned when no top-level value was a string.
  Conditions are now walked recursively, and an array target is treated as Node's
  fallback list — each candidate tried in order until one exists on disk, which is
  what the `.` entry already did and subpaths could not.

  Condition precedence stays deliberately source-first (`types` → `typings` →
  `import` → `default`) rather than Node's runtime precedence: this tool never
  executes the package, and the published runtime target usually points at a
  gitignored `dist/`. That is the same reasoning as `05ef8dc`.

- **A raw NUL byte made `agentmap.mjs` unsearchable.** `dirtyFingerprint` used a
  literal `\x00` as a rename delimiter in a cache-key token. The delimiter is the
  right choice — it is the one byte no path can contain, which is why `git status -z`
  uses it — but writing it as a raw byte rather than the `\0` escape made `file`
  classify the whole 3.7k-line module as binary, after which grep suppresses
  matches. Two independent audits hit it and one silently got zero results. The
  token hashes identically; only the source encoding changed. A test now fails on
  any raw NUL in a shipped file.

- **A second extension ladder in `packageImportsToPaths`**, and a third in
  `eval/eval.mjs`'s git-grep pathspec (which was missing `*.cjs`, so the grep
  baseline searched fewer files than agentmap mapped). Both now derive from the
  canonical list. The guard is a test that iterates the live `CODE_EXT` constant
  rather than restating it, so a ninth extension is covered the day it is added —
  proven to fail when the two are forced apart. `vite.config.mts`/`.cts` were also
  being skipped by a subset ladder.

- **`test/doctor.test.mjs` hand-synced the schema number**, which went stale on
  this very bump. It reads the live constant now.

- **The post-commit rebuild could orphan itself and burn a core.** The refresh is
  backgrounded so it outlives the commit shell — which also means a run that hangs
  is reparented to init with nothing left to reap it. Observed in the wild at **21
  minutes of CPU in 21 minutes of wall time** (a full core, killed by hand), with a
  fresh orphan stacking on every subsequent commit.

  `hooks/post-commit` now takes a single-instance lock and enforces a hard timeout.
  The lock is an atomic `mkdir`, so a commit landing while a rebuild is still
  running skips instead of piling on; the runner is backgrounded under a watchdog
  that `kill -9`s it after `AGENTMAP_HOOK_TIMEOUT` seconds (default 120 — a normal
  rebuild takes 1–3s). A lock older than 10 minutes is cleared first, so one killed
  rebuild can never disable auto-refresh permanently — that failure would be worse,
  and quieter, than the leak it guards against.

  Verified end-to-end before shipping: a normal commit still refreshes and releases
  the lock; a held lock skips with zero stray processes; a deliberately hung runner
  is killed by the timeout and the lock is released; a stale lock is cleared and the
  refresh resumes. Two of those are now regression tests in
  `test/post-commit-hook.test.mjs`, and both fail against the previous hook.

## [0.17.0] - 2026-07-26

### Added
- **Language census on every build.** `languageCensus()` counts `git ls-files`
  by extension and prints a one-line pointer on **stderr** when a single
  unsupported language is >=30% of counted SOURCE files — docs and data are
  deliberately excluded from the count, so a markdown-heavy TS repo doesn't
  trip it and a repo with one build script in another language stays quiet.
  Output is stderr specifically so `--json` stays a clean contract for the
  agents parsing stdout; `AGENTMAP_NO_CENSUS=1` opts out. Points at the pinned
  voting issue #43.

  Replaces a gate that could never fire: the previous plan was "wait until
  someone asks for Python," but a user whose repo agentmap can't read gets a
  useless map and leaves without filing anything — two people forked to add a
  language (rifanid98/agentmap-go, dstwn/agentmap-php) rather than open an
  issue. No telemetry: counted locally, printed locally, never leaves the
  machine.

### Fixed
- **`--callers` / `--calls` were blind to JSX.** A JSX element is an invocation in
  every runtime — `<Foo />` compiles to `React.createElement(Foo, …)` (classic) or
  `jsx(Foo, …)` (automatic) — but both call-graph directions collected only
  `CallExpression` / `NewExpression`, so every React component under-reported its
  callers and a component that merely renders children reported **zero** outgoing
  calls. Measured on a real React repo: `--callers Container` returned **0 call
  sites** before, **43** after.

  This was the worst instance of the failure class the tool is built to prevent: a
  shipped feature returning under-counted results with exit 0, under an explicit
  "compiler-accurate, not tree-sitter name-matching" label (`mcp.mjs:81`). A
  name-matching `rg '<Container'` beat it outright.

  Both directions now share one `invocationOf()` helper rather than two copies of
  the same filter — the incoming path had drifted into being the only one anybody
  reasoned about. `JsxClosingElement` is deliberately not matched, so
  `<Foo>…</Foo>` counts once; `<Foo.Bar />` resolves to `Bar`, not the `Foo`
  namespace; and intrinsic tags (`<div>`) still produce no in-project edge.
  Non-JSX repos are unaffected — asserted.
- **Three documentation claims that were false.** `.claude-plugin/plugin.json`
  said `0.14.0` while the package shipped 0.15.0 → 0.16.1 (this is the version
  users see in the Claude Code marketplace); the README badge advertised Node
  `>=18` through the entire life of the `>=20` breaking change; and
  `hooks/INSTALL.md` listed a `tsconfig.json` as a hard prerequisite, which it
  has never been — `makeProject()` falls back to source globs when the config is
  missing, malformed, or solution-style (`agentmap.mjs:823-825`), so plain-JS
  repos map fine.
- **Version drift is now caught by `npm test`.** New
  `test/version-lockstep.test.mjs` asserts `server.json` (both fields),
  `.claude-plugin/plugin.json` and the README Node badge all track
  `package.json`. `publish.yml` already gated `server.json`, but nothing watched
  `plugin.json` at all, which is how it drifted two minor versions unnoticed —
  and a publish-time gate only fires once a tag is pushed, which costs a
  delete-and-move of a published tag to recover from.
- **Eval fixtures now pin exact commits.** The eval pinned nothing: `git clone
  --depth 1` took whatever HEAD was that day and merely recorded the sha
  afterwards, so published accuracy figures were not re-derivable and a
  number moving between runs conflated "agentmap changed" with "the upstream
  repo changed." Fixtures now pin full 40-char shas — GitHub refuses
  fetch-by-abbreviated-sha, so the abbreviated form fails outright — fetched
  as a single object so the cost matches the old shallow clone. `--repin`
  re-pins deliberately and prints the new shas; a mismatched working copy now
  fails loudly instead of silently measuring something else. `EVAL.md` states
  it.
- **Workspace cross-package resolution silently dropped published-entry
  packages.** A workspace package declares its PUBLISHED entry —
  `main: "dist/index.js"` — and `dist/` is normally gitignored, so resolution
  landed on a path not in the repo and the cross-package edge disappeared
  silently. Three shapes returned **zero** dependents before the fix:
  `main: dist/index.js` -> 0, `exports: { ".": "./dist/index.js" }` -> 0, and
  `main: dist/index.js` + `types: src/index.ts` -> 0. The third is a plain
  correctness bug: TypeScript resolves `types`/`typings` AHEAD of `main`, and
  agentmap read neither field, nor the `types` export condition (`condLeaf`
  preferred `import`/`default`).

  Fix: `types`/`typings` and the `types` condition now come first, matching
  TypeScript's own preference; then a `./src/index` last resort, after every
  declared entry, for packages whose only declared entry is unbuilt. A
  declared entry that resolves ALWAYS outranks the fallback (asserted). A
  bare import of an undeclared package still fabricates nothing. agentmap's
  own map is byte-identical. 7 tests in
  `test/workspace-entry-resolution.test.mjs`.

## [0.16.1] - 2026-07-26

### Added
- **CI now exercises the shipped command.** A new `install-smoke` job (Node
  20/22/24) packs the tarball, installs it into a scratch consumer project, and
  drives the real binary: bin symlink, `npx`, a global install, `--mcp`
  JSON-RPC `initialize`, and `--install-hooks` followed by a real commit that must
  **measurably rewrite `map.json`'s `generatedSha`**. Every step asserts on
  OUTPUT — exit 0 with empty stdout was the bin bug's own signature, so exit
  status alone proves nothing. The previous suite never touched the bin path
  (`npm pack --dry-run` executes nothing), which is why 356 green tests and a
  green CI badge sat on top of 12 broken releases.

### Fixed
- **The CLI never ran through its own `bin`.** npm links
  `node_modules/.bin/agentmap -> ../@raymondchins/agentmap/agentmap.mjs`, so
  `process.argv[1]` is the SYMLINK while `import.meta.url` is the REAL path. The
  entry guard string-compared the two, concluded "imported, not executed", and
  skipped `main()` — so **`npx @raymondchins/agentmap`, `npm run agentmap`,
  `--install-hooks`, and the MCP Registry's `--mcp` launch all printed nothing
  and exited 0**. Shipped in **12 published versions, 0.10.0 through 0.16.0**;
  0.9.0 and earlier are unaffected. `isDirectRun()` now compares `realpathSync()`
  on both sides, in `agentmap.mjs` and `mcp.mjs` alike.

  The affected range is measured against published tarballs, not read off tags:
  `git tag --contains a217331` (the Batch 2 modularization that introduced the
  guard) starts at v0.12.1, but 0.10.0 and 0.11.0 were published manually off the
  same day's work, so tag ancestry understates the blast radius. Installing each
  version and invoking through `node_modules/.bin/agentmap` is what settles it:
  0.9.0 prints `0.9.0`, 0.10.0 prints nothing.

  Local installs configured by `--setup-mcp` were unaffected — it writes a direct
  file path (`agentmap.mjs:2358`). The MCP surface died specifically on the
  Registry/npx path, which routes through the broken CLI bin.

  Exit 0 with empty stdout is why this survived 356 green tests: every test
  invoked `node <abs path>/agentmap.mjs`, the one form that happened to work, and
  CI never exercised the bin. `test/bin-symlink.test.mjs` now runs the shipped
  command through a real symlink and asserts on OUTPUT, not just exit status —
  covering `--version`, a query, `--install-hooks` (asserts the hook file is
  actually written), `--mcp`, `mcp.mjs` standalone, and that importing the module
  still executes nothing.
- **`--doctor` no longer greenlights an unusable map.** `build()` has always
  persisted `fileCount` / `edgeCoverage` / `degraded` and warned on stderr, but
  `collectMapStatus()` read none of them — so a map containing **zero source
  files** reported `Map cache: ok` once the build-time warning scrolled past. It
  now reports `invalid` for an empty map and `degraded` (with the measured edge
  coverage) when most imports failed to resolve, and both roll up into
  `overall`. Fresh-and-empty is worse than stale: stale tells you to rebuild, `ok`
  tells you nothing is wrong. `--doctor` still always exits 0 — that is the
  documented contract (`README.md:761`); the report was the broken part, not the
  exit code. Caches written before schema 5 lack these fields and still read as
  `ok`, so older installs are not falsely flagged.
- **Corrected a false build warning.** The degraded-map message told users
  "Aliases from vite.config/webpack aren't read yet; mirror them into tsconfig
  paths" — work agentmap already does: `VITE_CONFIG_RE` (`agentmap.mjs:579`)
  probes vite/vitest/webpack configs and `readBundlerAliasEntries()` (`:587`)
  AST-parses their `resolve.alias`, covered by `test/vite-alias.test.mjs`. It now
  names the real gaps: tsconfig `references` (solution-style configs) and
  computed alias idioms (function/regex/URL), which are genuinely skipped.
## [0.16.0] - 2026-07-26

### Changed
- **Minimum Node is now 20** (`engines` was `>=18`). This is a breaking change for
  anyone still installing on Node 18. The floor is set by the dependency tree, not
  by EOL dates: `brace-expansion` — pulled in transitively via `ts-morph` →
  `@ts-morph/common` → `minimatch`, and bumped to 5.0.8 for GHSA-mh99-v99m-4gvg —
  declares `20 || >=22`, so `>=18` was a claim the installed tree contradicted.
  npm only warns on a transitive `engines` mismatch, but pnpm and anyone running
  `engine-strict=true` got a hard install failure on Node 18. agentmap's own code
  uses nothing above Node 18; this is purely about telling the truth.
- **CI matrix is now `[20, 22, 24]`** (was `[18, 20, 22]`) — the new floor, current
  LTS, and forward coverage, at the same three-leg cost.
- **Three test assertions dropped needless regexes** that tripped CodeQL as high-severity
  findings. `assert.match(out, /-->/)` (a Mermaid arrow) read as `js/bad-tag-filter`, an
  incomplete HTML-comment-end filter; `new RegExp(PKG.version.replace(/\./g, "\\."))`
  read as `js/incomplete-sanitization`, a hand-rolled regex escape that does not escape
  backslashes. Both were false positives — no shipped code is involved — but neither
  assertion needed a regex at all, so `.includes()` removes the finding at its cause
  rather than suppressing it. No behavior change; 356/356 tests still pass.

## [0.15.1] - 2026-07-19

### Fixed
- **MCP Registry publish unblocked.** The registry now enforces a 100-character limit
  on `server.json`'s `description` (422 on v0.15.0's publish; npm publish itself was
  unaffected). Shortened the description to comply. No code changes.

## [0.15.0] - 2026-07-19

### Fixed
- **Nudge hooks now self-gate on project presence.** All four PreToolUse/BeforeTool
  variants (`hooks/agentmap-nudge.mjs` for Claude Code, `hooks/agentmap-codex-nudge.mjs`,
  `hooks/agentmap-gemini-nudge.mjs`, `skills/opencode-agentmap-nudge.js` for OpenCode)
  ship at user/global scope (plugin bundles, `~/.gemini`/`~/.codex`/`~/.config/opencode`
  installs), so they used to fire in EVERY repo — including ones with no agentmap at
  all, where the nudge was pure noise. Each hook now walks up from the tool call's cwd
  (bounded, ~12 levels) looking for `node_modules/@raymondchins/agentmap` or a built
  `.claude/agentmap/map.json`; no hit → stays silent (Claude/Gemini: no-op, exit 0;
  OpenCode: no log). **The Codex gate fails open** — the presence check runs before
  every deny path, so a repo without agentmap is never denied a grep it was already
  allowed to run.

## [0.14.0] - 2026-07-04

### Added
- **Community-health files + onboarding docs.** GitHub issue forms (bug report +
  scope-gated feature request) with a `config.yml` routing questions to the README,
  a PR template that mirrors the one-file / one-dep / freshness / byte-identical
  invariants, a CONTRIBUTING "Submitting a PR" section, and README **Uninstall**
  (per-platform removal) + **Troubleshooting** tables.
- **React Server/Client boundary tags.** Each file now carries an optional
  `rsc: 'client' | 'server'` fact, read compiler-accurately from the directive
  prologue (`'use client'` / `'use server'`) and surfaced in `--relates` (prose +
  JSON, CLI + MCP). Additive + discovery-only — never touches PageRank / edges /
  features, and the key is ABSENT (not null) for files with no directive, so
  `map.json` is byte-identical for non-Next repos.
- **Hybrid lexical retrieval — `--search <query>` + a BM25 rung in `--any`.** Answers
  VAGUE natural-language queries an agent actually types ("where's the auth retry
  logic", "the function that dedupes symbols") that exact `--find` / `--any` miss. A
  pure-JS BM25 index (one doc per symbol: split-identifier name + path segments +
  feature + kind — no embeddings, no vector DB) is built into `map.json` and fused
  with file PageRank so a strong hit in an important file wins ties. `--search` is
  the explicit entry point; inside `--any` the same ranker slots in as a rung that
  fires ONLY when exact matching found nothing, so every existing `--any` result
  stays byte-identical. Also the `search` MCP tool.
- **`--export mermaid | dot` — visualize the import graph.** Serializes the file
  import graph (nodes = files, edges = imports, top-N by PageRank, 3 style tiers) as
  Graphviz DOT or Mermaid — paste into mermaid.live / a GitHub README / `dot -Tsvg`.
  `--focus <path>` scopes to a file's 1-hop neighborhood. Reads the cached map only
  (no ts-morph Project), so the fast path is untouched; not wired into `--json` (the
  graph text *is* the output).
- Map `SCHEMA_VERSION` bumped 4 → 5 (adds the per-file `rsc` fact + the top-level
  `lexical` index); caches rebuild once on upgrade.

## [0.13.1] - 2026-07-04

### Added
- **Outgoing call graph (`--calls <symbol>`).** The companion to `--callers`: every
  in-project symbol a given symbol INVOKES, resolved by the TypeScript language
  service (`getDefinitionNodes` — go-to-definition, which follows an imported /
  re-exported binding through to the real declaration, not the import site).
  Constructors (`new X()`) and member calls (`obj.m()`) resolve; `node_modules` and
  TS built-ins are excluded; dynamic dispatch and higher-order indirection are
  honestly skipped. Same lazy, out-of-band model as `--callers` (builds a Project
  only on the query; nothing persisted) and the same `--in` disambiguation. Also the
  `calls` MCP tool. Experimental.
- **Transitive `--depth N` for the call graph.** `--callers` / `--calls` (and the
  `callers` / `calls` MCP tools) accept `--depth N` (default 1, max 5) for an N-hop
  caller/callee closure — "who transitively reaches this" / "the full dependency cone
  of this". It BFS-traverses the same single warm Project (no extra build), with
  cycle detection and per-level + total-node caps so a hub can't explode; each node is
  tagged with its `depth` and a `via` parent for chain reconstruction. `--depth 1`
  (or omitted) is byte-identical to the single-hop output.

## [0.13.0] - 2026-07-04

### Added
- **Non-exported top-level symbols are now findable.** `--find` / `--any` (and their
  MCP tools) surface non-exported module-scope declarations — function, class,
  interface, type, enum, and top-level `const` — not just exports, so
  reuse-before-rebuild works for a private helper too. They are **discovery-only**:
  `rankSymbols` / `--map` / `--symbols` / `--hubs` never read them, so the focused
  ranked digest stays byte-identical (a local can never enter `rankedSymbols` or trip
  the definer-rarity penalty). Only module-scope declarations are indexed — nested
  body-locals are not. Each local hit carries `local: true`; `--no-locals` hides them
  at query time. Schema bumped 3 → 4, so old caches rebuild once on upgrade.
- **Compiler-accurate call graph (`--callers <symbol>`).** Symbol-level blast
  radius — "who calls this function?" — resolved by the TypeScript language service
  (ts-morph `findReferencesAsNodes`), NOT tree-sitter name-matching: a type-position
  mention, a re-export, a bare value reference, or a same-named private local in
  another file is never mis-attributed. Also exposed as the `callers` MCP tool. A
  deliberate DEEP query — it lazily spins up the TS type-checker (seconds on a large
  repo) only when invoked, so the map build and every other query stay fast and
  nothing is persisted to `map.json`. `--in <path>` disambiguates a name defined in
  multiple files (exported definitions take precedence over same-named private
  locals); results are ranked by caller-file PageRank and capped. Experimental.

## [0.12.3] - 2026-07-04

### Added
- **`npx skills add` compatibility.** The packaged skill moved to the
  `skills/agentmap/SKILL.md` layout so `npx skills add raymondchins/agentmap`
  (the vercel-labs/skills CLI + skills.sh) installs it directly; `--install-skill`
  and all install destinations are unchanged.

## [0.12.2] - 2026-07-04

### Added
- **Codex CLI PreToolUse gate.** `--install-skill --platform codex` now installs a
  real PreToolUse hook (`.codex/config.toml` + a copied `agentmap-codex-nudge.mjs`),
  not just docs — Codex moves from docs-only to live enforcement. It denies only the
  narrow, high-confidence structural-search case (bare-symbol / dependency / component
  grep) with a reason steering to agentmap, and allows everything else (piped
  log-filters, data-file operands, non-structural sweeps); `AGENTMAP_CODEX_GATE=0`
  bypasses. (Codex only honors deny/allow on PreToolUse — an `ask` / `additionalContext`
  fails open, so a soft nudge can't work there.)
- **MCP Registry-ready.** A repo-root `server.json` (schema 2025-12-11, name = the
  existing `mcpName` `io.github.raymondchins/agentmap`) lets `mcp-publisher publish`
  list agentmap in the official MCP Registry.

### Changed
- **Honest competitive positioning.** The README no longer implies the agent-loop
  wiring (post-commit refresh + `PreToolUse` nudge) is unmatched — it isn't. Reframed
  around agentmap's real, defensible wedge: compiler-grade `ts-morph` TS/JS accuracy
  (tsconfig/vite/webpack aliases, `#imports`, workspaces all resolve) backed by a
  published accuracy eval. Tagline → "The TS/JS-accurate repo map"; the name-collision
  note is strengthened up top; `package.json` description + keywords broadened.

## [0.12.1] - 2026-07-04

### Added
- **package.json `"imports"` subpath resolution.** Self-referencing internal
  specifiers (`import x from '#lib/util'` / `#internal/*`) now resolve to their
  source (JSON-parsed, never executed), completing the alias story alongside
  tsconfig / vite / workspace resolution. A repo without an `"imports"` field is
  byte-identical (verified A/B on a frozen 519-file corpus).

### Performance
- **In-process MCP server.** The 8 MCP tools now answer in-process against a map
  parsed once (invalidated by the same freshness key the CLI uses) instead of
  spawning a fresh `node agentmap.mjs` per call — the per-call double-Node-spawn +
  whole-repo reparse that was the entire experience for Cursor / Cline /
  Claude-Desktop users (MCP is their only integration). Tool outputs are
  byte-identical to the old spawn path (all 8 tools across 17 query/edge combos;
  `agentmap --mcp` verified end-to-end, no cyclic-import deadlock); the CLI path
  is untouched. Warm query ~93ms spawn -> ~22ms in-process.

### Security
Fixes from a full security audit — which also confirmed a genuinely solid
posture: **zero** committed secrets across full history, `npm audit` clean, and
the config readers (vite/webpack/tsconfig/package.json) are AST/JSON-parse only
and **never execute** untrusted repo config.
- **ReDoS in the `.agentmapignore` matcher (real DoS, fixed).** A line of
  consecutive `*` compiled to adjacent `[^/]*` groups (catastrophic
  backtracking) — a `*`x50 line hung the per-path matcher ~80s, freezing
  `build()`, the post-commit auto-refresh hook, and the MCP server. Runs of `*`
  are now collapsed before translating (this glob subset has no `**` semantics)
  and a line-length cap is applied; a poisoned ignore file builds in <1.5s. +test.
- **Supply-chain hardening.** All 9 GitHub Actions are pinned to full commit
  SHAs (notably the third-party `gitleaks-action` in the `NPM_TOKEN` publish
  path); a `dependabot.yml` (npm + github-actions) keeps the pins current.
- **MCP untrusted-content fence.** The `--any` content fallback returns raw
  git-grep repository bytes; the MCP server now appends an explicit
  untrusted-data marker (a second content block, so `content[0]` stays
  byte-identical to the CLI) so a planted "ignore previous instructions" in an
  ordinary file reads as DATA, not a command.
- **`--install-hooks` no longer silently clobbers an existing `post-commit`
  hook** — a user's own hook is backed up to `post-commit.pre-agentmap` with a
  warning before agentmap's hook is written.
- **SECURITY.md** supported-version line updated `0.9.x` -> `0.12.x`.

## [0.12.0] - 2026-07-04

### Added
- **Map-health signal.** Every clean build now reports `edgeCoverage` (the share of
  repo-local-looking import sites that resolved to an in-project edge) and a `degraded`
  flag in `map.json` and the `--json` build output, and prints one honest stderr line
  when the map is empty (`0 source files found …`) or degraded (`N files, K import
  edges resolved — most imports unresolved …`). Turns a silently broken/empty map — the
  moment a new user assumes the tool doesn't work and uninstalls — into a clear, fixable
  signal. Healthy repos (coverage ~1) never trip it.
- **vite / vitest / webpack `resolve.alias` resolution.** A repo that aliases `@/` only
  in `vite.config` (the default `npm create vite` shape, not `tsconfig`) previously
  produced a fully inert map — zero resolved edges. The alias object is now read from the
  config's AST **without executing the config** and merged with `tsconfig` `paths`
  (tsconfig wins on conflict; function/regex aliases are deferred).
- **Workspace cross-package resolution (pnpm/npm/yarn).** `import '@org/pkg'` and its
  subpaths now resolve to the target package's source across package boundaries, so
  blast-radius and hub ranking no longer silently break at the monorepo package wall.
- **`.agentmapignore`.** A repo-root ignore file (gitignore-style subset: anchored `/`,
  dir `/`, `*` globs, `#` comments) excludes extra paths beyond the built-in
  `node_modules`/`.git`/`.next` skip list.
- **Claude Code plugin + marketplace + MCP Registry name.** `.claude-plugin/{plugin,
  marketplace}.json` make `/plugin marketplace add raymondchins/agentmap` +
  `/plugin install agentmap@agentmap` bundle the skill, the PreToolUse nudge, and the
  stdio MCP server in one auto-updating install (validated with `claude plugin validate
  --strict`). `mcpName` added to `package.json` for the MCP Registry. README gains an
  honest per-platform onboarding matrix (live-hook vs MCP vs docs-only) and a copy-paste
  `.cursor/mcp.json`.

### Changed
- **`.d.ts` files are excluded from the symbol ranking by default.** A generated
  declaration file (supabase/prisma/protobuf types, `next-env.d.ts`) no longer floods
  `--find`/`--symbols`/`--hubs` or hijacks the top hub. `.d.ts` files remain live
  import-resolution targets (edges to them are preserved); `--include-dts` restores the
  old behavior via a separate cache (`map.dts.json`), so the default `map.json` is
  untouched. **This changes the map for any repo with `.d.ts` files.**

### Fixed
- **PreToolUse nudge now fires on a bare-symbol `Grep`.** `{Grep, pattern:"ProviderCard"}`
  — the single most common structural search on Claude Code — previously never nudged,
  because the bare-PascalCase rule was gated to the Bash branch only. The emitted command
  is also now `npx @raymondchins/agentmap` instead of a `node node_modules/…` path that
  ENOENTs on npx/global installs (the README's headline install), which had taught the
  agent the tool was broken and driven a permanent grep fallback.
- **Gemini nudge now actually injects.** It emitted `hookSpecificOutput.additionalContext`
  on a `BeforeTool` event, which Gemini CLI silently drops — so `--install-skill` wired
  it and `--doctor` reported it installed, but it never reached the model. Now emits a
  top-level `systemMessage` (a BeforeTool-supported, model-visible field).
- **Correctness quick-wins (Batch 5).** Six independent resolution/robustness bugs,
  each found + confirmed with a repro and covered by a regression test:
  - **tsconfig `extends` origin** — inherited `baseUrl`/`paths` now resolve against
    the base config's own directory (anchored absolute at read time), not the child's,
    so monorepo shared-config alias edges resolve correctly instead of being dropped
    or mis-wired to a same-named local file.
  - **Longest-prefix alias precedence** — overlapping `paths` (e.g. `@/*` +
    `@/components/*`) now follow TypeScript's rule (exact, then longest fixed prefix)
    instead of first-declared order.
  - **Dirty tsconfig busts the cache** — editing `tsconfig.json`/`jsconfig.json`
    (which changes alias resolution for every file) now invalidates the cache; before,
    a config-only edit served a stale map with wrong import edges.
  - **Rename to a non-source path** — `git mv foo.ts foo.txt` now busts the cache
    (the vanished source file is removed from the map) instead of leaving a ghost.
  - **Non-ASCII / special-char filenames** — files like `src/café.ts` no longer
    silently disappear from the map (`git ls-files -z` + `core.quotePath=off`).
  - **Prototype-pollution in `resolveFile`** — `--any constructor` / `--relates toString`
    (any `Object.prototype` name) no longer crash (prose) or fabricate a false file
    hit (JSON/MCP); uses `Object.hasOwn`.

### Performance
- **Capped `--find`/`--any` symbol matches (Batch 3).** A broad symbol query used to
  emit every matching export (thousands / ~93k tokens on a large repo, defeating the
  token-savings point). Matches are now ranked by the containing file's PageRank and
  capped to 50, with a "showing top N of M by pagerank — narrow your query" footer in
  prose and `total`/`shown`/`truncated` (`--find`) and `symbolsTotal`/`symbolsTruncated`
  (`--any`) in JSON. Ranking keeps the most important matches when truncated; small
  result sets are unaffected.

## [0.11.0] - 2026-07-03

### Performance
- **Dirty-tree caching (Batch 3).** A dirty git working tree no longer re-parses the
  whole repo on every query — the #1 real-world cost, since agents work on dirty
  trees essentially always.
  - **Tier 1 — dirty-map cache (default, on).** The dirty build is cached to
    `.claude/agentmap/map.dirty.json`, keyed by `sha1(HEAD + dirty-file
    path:mtime:size)`. Back-to-back queries on an unchanged dirty tree reuse ONE
    rebuild (content-os 365 files: ~1.8s → ~0.12s, **~15×**). The clean `map.json`
    is never clobbered by a dirty build, so the dirty→clean transition serves the
    clean cache with no extra rebuild (also closes the old cache-poison bug).
    Byte-identical to the previous dirty output; verified on a fixed corpus.
  - **Tier 2 — true incremental (experimental, opt-in via `AGENTMAP_INCREMENTAL=1`).**
    When every change is a MODIFICATION of a file already in the map, agentmap
    re-parses ONLY the changed files (against empty ts-morph stubs of the rest) and
    re-runs the cheap global assembly — byte-identical to a full rebuild at a
    fraction of the cost (dirty-1 ~1.8s → ~0.62s, **~2.9×**). It declines to a full
    dirty build (Tier-1 cached) for adds/deletes/renames, re-export barrels,
    CommonJS `module.exports`, monorepo nested tsconfig/package.json, and laundered
    default re-exports. Three rounds of adversarial verification (20 import-resolution
    shapes across 7 real repos) found a tail of isolated-reparse edge cases where an
    ungated modify could still diverge (`.d.ts` edges, `package.json` `exports`
    field, barrel+target combos), so Tier 2 ships **off by default** until that tail
    is exhausted; the proven byte-identical Tier 1 is the default win. On any
    miss/error it falls back to a full build.
  - Clean builds persist a raw per-file facts snapshot to `.claude/agentmap/facts.json`
    for the incremental rebuild. `map.json` output is unchanged (byte-identical).

### Added
- **Tag-triggered publish workflow** (`.github/workflows/publish.yml`) — pushing a `v*`
  tag runs the full test gate, then publishes to npm with **provenance** (OIDC-signed
  supply-chain attestation, only possible from CI) and cuts a GitHub Release. Guards
  against tag/`package.json` version drift. One-time setup: add an npm Automation token
  as the `NPM_TOKEN` repo secret. (Batch 4 — release engineering.)

### Changed
- **README trust markers** — states the privacy posture ("fully local — no network calls,
  no telemetry", verified: zero `fetch`/`http` in source) and a name-collision caveat
  (`npx agentmap` unscoped is an unrelated package; always use `@raymondchins/agentmap`).

## [0.10.0] - 2026-07-03

### Added
- **Programmatic API — agentmap.mjs is now importable with zero side effects.** The
  CLI arg-parse + dispatch moved inside a `main()` guarded by an `import.meta.url`
  check (the same one `mcp.mjs` uses), so `import("@raymondchins/agentmap")` no longer
  executes the CLI or writes a cache into the importer's cwd. It exports the pure
  building blocks: `pagerank`, `rankSymbols`, `identMul`, `resolveFile`,
  `extractVueScripts`, `stripJsonComments`, `extractFacts`, `build`, `ensureFresh`,
  `readPackageVersion`. (Batch 2 — modularization; unblocks in-process MCP + unit tests.)
- **`extractFacts()` backend seam.** `build()` is split into `extractFacts()` — the only
  code that knows ts-morph / Vue SFCs, returning per-file facts (exports, imports,
  imported symbols, re-exports, default-export name) — and a backend-agnostic `build()`
  that assembles the graph, PageRank, symbol ranking, and cache from those facts. A
  second language backend becomes a drop-in producer of the same shape.
- **In-process unit tests** (`test/unit.test.mjs`) exercising the exported pure functions
  directly (no subprocess spawn), including the `extractFacts` seam contract.
- **Command-table validation.** A declarative command table now rejects conflicting
  commands (`--map --doctor`) and orphan sub-flags (`--focus` with no `--map`, `--platform`
  with no `--install-skill`, …) with a clear usage error (exit 2) instead of silently
  running whichever branch matched first.
- **`focusResolved` in `--map --json` output** — `true`/`false` when `--focus` was
  requested (resolved or not), omitted when no `--focus` was passed. The structured half
  of the exit-code signal below.

### Changed
- **Exit-code contract tightened.** Exit 1 is now reserved for "query had zero results"
  — and an unresolved `--map --focus <no-match>` joins that bucket (it used to silently
  degrade to the global digest at exit 0; it still prints the digest, now at exit 1 with
  `focusResolved:false`). Maintenance-command failures (`--install-hooks`, `--install-skill`,
  `--setup-mcp`, `--doctor`, `--hook-status`, `--mcp`) now exit **3** instead of colliding
  with the exit-1 "zero results" bucket. USAGE + the MCP classifier comment updated to match.
- **Writer/checker pairs unified.** `setupMcp` (writer) and `collectMcpStatus` (checker) now
  read one `MCP_TARGETS` table; `installHooks` and `collectHookStatus` share one set of
  hook-wiring identifiers + a `nudgeMatcherWired` predicate — no more parallel literals kept
  in sync by comment. Behavior-identical.
- **Internal refactor only — map output is byte-identical.** The source-extension list
  (previously hardcoded in 5 places) is hoisted into one per-backend descriptor
  (`CODE_EXT` / `SOURCE_EXT`), and the relative-specifier branch of `resolveSpec` (which
  re-implemented `tryResolveAt` behind a `join` local that shadowed `joinPosix`) collapses
  onto the shared helpers. No change to the map, hubs, rankings, or exit codes — verified
  byte-identical against the pre-refactor build.
- **Housekeeping.** Removed a dead `statSync` import; `--version` now reuses the exported
  `readPackageVersion()` instead of re-reading `package.json` inline.

### Security
- **Expanded the content-search secret denylist.** The `--any` / MCP content fallback now also
  excludes SSH private keys (`id_ed25519*`, `id_ecdsa*`), keystores (`*.p8`, `*.jks`,
  `*.keystore`), and credential dotfiles (`.npmrc`, `.netrc`, `.git-credentials`, `.pgpass`,
  `.htpasswd`, `.pypirc`) at any depth. Deliberately NOT a broad `token` name match — that
  would over-exclude ordinary source like `tokenizer.ts`. SECURITY.md + regression tests updated.
- **Post-commit hook no longer runs a repo-local `./agentmap.mjs` by default.** A working-tree
  `agentmap.mjs` is attacker-plantable (any branch/PR can add it), so the hook firing on the
  next commit was arbitrary code execution. Repo-local execution now requires an explicit
  `AGENTMAP_HOOK_ALLOW_LOCAL=1` opt-in (for developing agentmap itself); by default the hook
  runs only the installed package — `node_modules/.bin/agentmap`, a PATH binary verified to be
  `@raymondchins/agentmap`, or `npx @raymondchins/agentmap` — which also closes the bare-`agentmap`
  PATH-hijack fallback. Replaces the previous `AGENTMAP_HOOK_NO_LOCAL` opt-out.
- **Content-search secret exclusion now matches plain secret files.** The `--any` denylist used
  `*.password*` (only `foo.password.ts`); it now uses `*password*` so `password.txt` /
  `passwords.json` are excluded too.

### Fixed
- **MCP server no longer reports crashes as "no results".** Exit code 1 is overloaded (the CLI
  uses it for zero-results, but it is also Node's uncaught-exception code), so a hard crash was
  returned to the client as a successful empty answer. Exit-1-with-empty-stdout is now surfaced
  as `isError`; genuine zero-result queries (which always print JSON to stdout) are unaffected.
  Spawn failures whose `err.code` is a string (`ENOENT`, `EACCES`, …) are now detected too.
- **CI ran only part of the test suite.** The workflow ran `node --test test/*.test.mjs`
  (116 tests), silently skipping the entire `test/vue-sfc/` suite; it now runs `npm test`
  (159 tests).

### Docs
- Truth-synced `SECURITY.md`, `README.md`, `hooks/INSTALL.md`, and `CONTRIBUTING.md`: corrected
  the cache path (`.claude/agentmap/map.json`), removed the nonexistent `--refresh` flag and the
  removed `scripts/agentmap.mjs` lookup, fixed the sensitive-file exclusion list, added the
  `--setup-mcp` flag and Vue SFC support to the README, and corrected the nudge verify commands
  (they need `tool_name`).

## [0.9.0] - 2026-06-16

### Added
- **`--doctor`** — a read-only harness health report that checks, in one place, the git
  `post-commit` hook, the `PreToolUse` nudge and its `.claude/settings.json` wiring, installed
  skills / Cursor rule freshness vs the `package.json` version, MCP config entries for
  OpenCode / Antigravity, and map-cache presence/freshness. Always exits 0 and suggests fix
  commands (`--install-hooks`, `--install-skill`, `--setup-mcp`) but never writes files. Pair
  with `--json` for a structured report.

## [0.8.0] - 2026-06-15

### Added
- **`--install-skill` platform expansion** (#6, #12, @muhajirdev) — `codex`, `opencode`, `gemini`, `antigravity`, `copilot` with paths aligned to each platform's documented skill directories. Also merges always-on `GEMINI.md` / `AGENTS.md` blocks, Gemini CLI `BeforeTool` hooks, and OpenCode plugin (same `--install-skill` command — no separate flag).

### Changed
- **`--platform all` default set** — now installs claude, cursor, codex, opencode, gemini, antigravity, copilot. Legacy `agents` is opt-in (`--platform agents`). Global `all` no longer writes `~/.agents/skills/` by default; use `antigravity` (`~/.gemini/config/skills/`) or explicit `agents` for v0.7.0 `~/.agents/` behavior.

### Fixed
- **Monorepo tsconfig path aliases** (#9, @muhajirdev) — `--relates` no longer undercounts dependents when a repo imports through tsconfig `paths` aliases (`@/*`, `#/*`, `~/*`) defined at a non-root package config. Alias-config discovery now also follows `extends`, so a package tsconfig that only `extends` a shared base (Turborepo `tsconfig.base.json` holding all `paths`) still contributes its inherited `baseUrl`/`paths`. Recursive, depth-capped, child overrides parent.
- **Windows Gemini docs path** — global `GEMINI.md` now routes to `~/.agents/GEMINI.md` on Windows (mirroring the skill destination) instead of the POSIX-only `~/.gemini/GEMINI.md`, so the always-on guidance lands where Gemini CLI reads it.

## [0.7.0] - 2026-06-15

### Added
- **`--hook-status`** (#5, @muhajirdev) — a read-only command that reports whether
  agentmap's git-hook wiring is installed: the `post-commit` hook (and whether it's
  agentmap's vs a foreign hook), the `PreToolUse` nudge file, the `PreToolUse(Grep)`
  + `PreToolUse(Bash)` wiring in `.claude/settings.json`, and the `.gitignore` entry.
  Detection is a substring marker scan, so a **chained** `post-commit` (agentmap
  sharing one hook with another tool) is correctly reported as installed.
- **`--install-skill`** (#4, @muhajirdev) — install packaged agent-guidance assets so
  coding agents are steered to agentmap before falling back to grep: ships a Claude
  Code / Codex / OpenCode `SKILL.md` and a Cursor always-on rule. Flags:
  `--platform claude|cursor|agents|all` (default `all`), `--project` (default) or
  `--global`, and `--dry-run`. Writes are atomic and whitelisted to fixed,
  agentmap-namespaced paths. The installer is lazy-imported so it never loads on the
  warm `--any`/`--find` query hot path.

## [0.6.1] - 2026-06-14

### Fixed
- **Graceful degradation:** the per-file parse loop now wraps each file in
  try/catch — a single pathological source (e.g. a malformed import specifier
  that makes ts-morph throw) is skipped with a stderr warning instead of
  aborting the entire map build.
- **Path aliases for dynamic edges:** tsconfig/jsconfig `baseUrl`/`paths`
  aliases (`@/x`, `~/x`) now resolve for side-effect imports, dynamic
  `import()`, and `require()` too — previously only static imports formed edges.
- **Symbol ranking:** re-export barrels (`export { X } from './y'`) are no longer
  counted as references to `X`, so heavily re-exported symbols are not over-ranked
  in barrel-heavy repos (file-level dependency edges are unchanged).
- **Dirty-tree detection:** `git status` rename parsing is gated on the porcelain
  status code, so a plain file whose name contains `" -> "` is no longer
  mis-parsed (which could serve a stale cache as fresh).
- **`--map` tiny budgets:** partial-recovery now tests down to a single symbol,
  so a very small `--tokens` value still emits the top file instead of nothing.
- **Non-git fingerprint walk:** per-directory try/catch (a permission-denied
  subdir no longer empties the fingerprint and disables caching) plus a recursion
  depth cap; mirrored in the non-git Vue walk.

### Docs
- Clarified that the `--any` content fallback is case-insensitive by design
  (matches `--find`); matches are printed verbatim so true casing is visible.

## [0.6.0] - 2026-06-14

### Added
- **`--setup-mcp`** — configure agentmap as an MCP server for OpenCode and the Antigravity
  IDE (merge-safe write into each platform's MCP config; `--dry-run` previews without writing).
  Complements the existing `--mcp` stdio server so MCP-capable agents can query the map without
  a manual config edit.

## [0.5.0] - 2026-06-14

### Added
- **Vue SFC `<script>` indexing (#2).** `.vue` single-file components are now indexed:
  their `<script>` / `<script setup>` blocks are extracted (via a virtual TS/JS path) and
  participate in the import/symbol graph like any other source file, so `--relates`,
  `--find`, and the ranked map cover Vue components too. Best-effort — the template block is
  not parsed. Bumps the cache `SCHEMA_VERSION` (old caches rebuild automatically).

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

[Unreleased]: https://github.com/raymondchins/agentmap/compare/v0.18.0...HEAD
[0.18.0]: https://github.com/raymondchins/agentmap/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/raymondchins/agentmap/compare/v0.16.1...v0.17.0
[0.16.1]: https://github.com/raymondchins/agentmap/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/raymondchins/agentmap/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/raymondchins/agentmap/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/raymondchins/agentmap/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/raymondchins/agentmap/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/raymondchins/agentmap/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/raymondchins/agentmap/compare/v0.12.3...v0.13.0
[0.12.3]: https://github.com/raymondchins/agentmap/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/raymondchins/agentmap/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/raymondchins/agentmap/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/raymondchins/agentmap/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/raymondchins/agentmap/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/raymondchins/agentmap/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/raymondchins/agentmap/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/raymondchins/agentmap/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/raymondchins/agentmap/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/raymondchins/agentmap/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/raymondchins/agentmap/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/raymondchins/agentmap/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/raymondchins/agentmap/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/raymondchins/agentmap/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/raymondchins/agentmap/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/raymondchins/agentmap/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/raymondchins/agentmap/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/raymondchins/agentmap/compare/v0.1.0...v0.2.0
