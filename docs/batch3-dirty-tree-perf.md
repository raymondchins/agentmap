# Batch 3 — Dirty-tree performance: design & plan

> Derived from a 5-agent research pass on 2026-07-03 (control-flow trace,
> mechanics inventory, test-coverage audit, an opus design pass, and two
> independent benchmark runs that agree). This is the implementation-ready plan
> for ROADMAP.md Batch 3's "Dirty-map caching / incremental invalidation" task.
> **Status: design only — not yet implemented.**

## 1. The problem, measured

`ensureFresh()` (`agentmap.mjs:841`) is the single freshness gate. On a clean git
tree it serves the cached `map.json`; on a **dirty** tree the guard at
`agentmap.mjs:853` (`cached.dirty === 0 && dirtyCount() === 0`) fails, so it falls
through to a full `build()` at `agentmap.mjs:864` — a whole-repo ts-morph reparse
**on every single query**. `extractFacts()` (the ts-morph parse) is the dominant
cost; everything after it (default-import resolution, dependents inversion,
PageRank, `rankSymbols`, hubs) is cheap in-memory graph math.

Baseline (best-of-3 real seconds, macOS, two independent measurements agree):

| Repo | Source files | Warm clean (cache hit) | Dirty query | Dirty query #2 (back-to-back) |
|---|---|---|---|---|
| agentmap | 40 | **0.10s** | 0.49s | 0.48s |
| content-os | 370 | **0.10s** | 1.67s | 1.70s |

**dirty #2 ≈ dirty #1 ≈ cold** — zero reuse. An agent firing 10 queries against a
dirty content-os tree pays ~17s instead of ~1.7s once + ~0.1s each. Extrapolating
to a 5k-file repo: ~15–20s **per query**. This is the #1 real-world killer because
agents work on dirty trees essentially always.

### Bonus finding — cache-poison on the dirty→clean transition

`build()` bakes `dirty: dirtyCount()` into the persisted `map.json`
(`agentmap.mjs:730`) and writes it regardless of the value (`:738–740`). Because
`ensureFresh()`'s clean guard requires `cached.dirty === 0` (`:853`), a map built
while the tree was dirty can **never** self-validate again — so the first query
after the tree goes clean always pays one extra full rebuild until a clean build
overwrites it. One-shot cost, not fatal, but fixable in the same change.

## 2. Enabler already in place (Batch 2)

`extractFacts(repo) → Map<path, {exports, importedSymbols, reExports,
defaultExportName}>` (`agentmap.mjs:515`) is the only ts-morph/Vue code; `build()`
(`agentmap.mjs:680`) is backend-agnostic assembly consuming those facts. Incremental
work only has to scope down `extractFacts()`; the assembly tail re-runs whole and
cheap.

## 3. Tier 1 — dirty-map cache (SHIP FIRST, ~0.5 day, zero algorithm risk)

**Goal:** back-to-back queries on the same dirty tree do ONE rebuild, not N. Served
map is **byte-identical** to today's dirty `build()` (we only add a cache layer in
front of the same builder).

### 3.1 Keying
`dirtyFingerprint = sha1("HEAD:" + currentSha() + "\n" + sortedDirtyTokens)` where
each dirty source file contributes:
- existing file → `path:mtimeMs:size` (mirror `sourceFingerprint()` at `:145`; `lstat` only the handful of dirty files, not the whole tree)
- deleted → `D:path`
- rename → new-path triple **plus** `R:old->new` (so a rename can't collide with an independent add+delete)

Include `currentSha()` so the same edit against a different HEAD keys differently.
Reuse `dirtyCount()`'s parser (`:122–134`) so the count and the key can't diverge.

### 3.2 Storage
- `MAP` (clean) = `.claude/agentmap/map.json` — **unchanged.**
- New `MAP_DIRTY = ".claude/agentmap/map.dirty.json"` (add const next to `agentmap.mjs:32–33`). Already covered by the gitignore of `.claude/agentmap/`.
- The dirty file embeds `dirtyFingerprint` as its own key field.

### 3.3 Edit points
1. **Refactor `dirtyCount()` → `dirtyFiles()`** (`:122–134`) returning `[{code, path, oldPath?}]`; `dirtyCount()` becomes `dirtyFiles().length`. One parser, two consumers.
2. **New `dirtyFingerprint(sha, dirtyList)`** near `sourceFingerprint()` (`:145`); `lstatSync` in try/catch → deleted branch (mirror the graceful pattern at `:162`).
3. **`build()` gets an optional param** `build({ target = MAP, extra = {} } = {})`: merge `extra` into `out` before serialize (`:734`), write to `target` (`:738/:740`). Default call sites (bare invoke `:1918`, post-commit) unchanged → still write clean `MAP`. Additive, no algorithm touched → byte-identity holds.
4. **In `ensureFresh()`, keep the clean fast-path at `:853` first** (clean trees never touch the dirty file). **After the whole `if (existsSync(mapPath))` block, before the final `return build()` (`:864`), insert:**
   ```js
   if (sha) {
     const dl = dirtyFiles();
     if (dl.length) {
       const dfp = dirtyFingerprint(sha, dl);
       if (existsSync(MAP_DIRTY)) {
         try {
           const dc = JSON.parse(readFileSync(MAP_DIRTY, "utf8"));
           if (dc.schema === SCHEMA_VERSION && dc.dirtyFingerprint === dfp) return dc;
         } catch {}
       }
       return build({ target: MAP_DIRTY, extra: { dirtyFingerprint: dfp } });
     }
   }
   ```
   (Must sit outside the `existsSync(mapPath)` block so it runs even when the clean `MAP` doesn't exist yet.)

### 3.4 Cache-poison fix (fold in here)
Optional best-effort `unlink(MAP_DIRTY)` on a clean hit at `:853` to avoid an
orphan file. The real transition cost is inherent to the current `cached.dirty`
gate; document that Tier 1's dirty cache makes the repeated-query cost vanish, and
the one-shot clean-transition rebuild is acceptable (or address by keying the clean
cache on HEAD alone and re-checking dirty separately — evaluate during impl).

### 3.5 Invalidation
Any change to the dirty file set (edit/save/new-untracked/delete/revert) →
different triples → key miss → one rebuild, rewrite `MAP_DIRTY`. Tree goes clean →
`:853` serves `MAP`, `MAP_DIRTY` ignored (self-invalidating via key). HEAD moves →
key miss. Schema bump → miss.

### 3.6 Effect
dirty #2..#N drops from ~1.7s to ~0.1s (~16× on repeated dirty queries) — closes
the dominant real-world cost (agents always fire multiple queries per tree state).

## 4. Tier 2 — true incremental (follow-up, ~2–3 days, risk concentrated)

Makes even dirty #1 fast. Only worth it if ~100ms+ rebuilds on large dirty trees
are still a felt cost after Tier 1 removes the per-query multiplication.

1. **Persist raw facts** — add `out.facts` (the `extractFacts()` return, captured
   **before** the default-import post-pass at `:687` mutates it and before
   `defaultExportName` is stripped at `:726`). Additive; consider a sibling
   `.claude/agentmap/facts.json` if `map.json` size matters. Incremental only runs
   when `facts.generatedSha` matches the HEAD being diffed; else full `build()`.
2. **Changed set** from `dirtyFiles()`: A/M/?? → reparse; D → remove; R → remove
   old + reparse new; C → add new; non-source → ignore.
3. **Subset-scoped `extractFacts(fileList, knownKeys)`** — parameterize
   `makeProject()` (`:389`) to `addSourceFilesAtPaths(subset)` instead of the full
   `git ls-files` discovery (`:430`). **Crux/risk:** a changed file importing an
   *unchanged* file must still resolve — feed the resolver a `knownKeys` set
   (cached clean paths ∪ changed paths − deleted) so `tryResolveAt` (`:546`) can
   resolve edges to unchanged targets **by key** without parsing them. The
   extensionless→`.ext`→`/index`→`.vue` ladder (`:546–554`) must be replicated
   against the key set **exactly**, or edges diverge from a full rebuild.
4. **Merge** into a deep copy of cached raw facts: delete removed, replace/insert
   changed. A file's own facts depend only on its own source, so unchanged files
   are untouched.
5. **Re-run ALL derived steps fully** (they are global and cheap): default-import
   resolution (`:687–693`), dependents inversion (`:697–699`), features
   (`:702–703`), file PageRank (`:705–712`, ~100ms at 5k), `rankSymbols` (`:715`),
   hubs (`:718–722`). Do **not** try to patch these surgically. Refactor: extract
   `assemble(rawFacts, {target, extra})` from `build()`'s tail so both full and
   incremental share it (operating on a fresh deep copy — it mutates
   `importedSymbols` and adds `dependents`/`pagerank`).

### Guards
- **G1** periodic full rebuild (every Nth incremental, or dirty-set > ~200 files).
- **G2** `AGENTMAP_VERIFY=1`: after incremental, run full `build()` and assert
  `JSON.stringify` equality of `files/hubs/features/rankedSymbols` (CI/regression only).
- **G3** wrap the incremental path in try/catch → on ANY error fall through to full
  `build()`. Incremental is a pure optimization; it must never fail a query.
- **Re-base each incremental off the CLEAN-HEAD facts**, never off the previous
  dirty map (avoids compounding drift).

## 5. Regression tests (write BEFORE implementing)

Existing contracts an incremental build must not break:
- `test/staleness.test.mjs:13–51` — any new-untracked-dir file busts the cache.
- `test/determinism.test.mjs:24–42` — byte-identical `hubs` across builds; `--hubs` stdout stable.
- `test/doctor.test.mjs:192–207` — cache requires clean-at-build **and** clean-now.
Helpers: `test/helpers.mjs` `writeFiles()` (`:32`) creates dirty state; `run()` (`:59`) runs the CLI.

New tests to add:
- **T1 byte-identity:** dirty fixture → reference `build()` vs `ensureFresh()` (miss then hit) deep-equal (ignoring `dirty`/`dirtyFingerprint`); second call does NOT invoke ts-morph (assert `MAP_DIRTY` mtime unchanged).
- **T2 invalidation:** touch a source file → next `ensureFresh()` rebuilds and matches a fresh `build()`.
- **T3 clean/dirty isolation:** dirty→clean serves `MAP`, never a stale `MAP_DIRTY`; clean tree never writes `MAP_DIRTY`.
- **T4 HEAD collision:** same dirty file, two HEADs → two keys → two rebuilds.
- **(Tier 2) T5–T8:** modify/add/delete/rename/add-import/remove-import/change-default-export-name each equal a full rebuild; edge-to-unchanged resolution across every specifier shape; fallback-on-error; the G2 verify harness over random edits.

## 6. Sequencing

Ship **Tier 1 + regression T1–T4** first (~0.5 day, zero algorithm risk,
byte-identical). Measure. Decide Tier 2 based on whether large-dirty-tree first-query
cost is still felt.

**Acceptance (Tier 1):** a second query on an unchanged dirty tree does not
re-parse (assert via `MAP_DIRTY` mtime / no "parsing N source files" log);
`npm test` green; byte-identical map content vs today's dirty `build()`.
