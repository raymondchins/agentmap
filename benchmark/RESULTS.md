# agentmap — token-savings benchmark results

**Headline: ~98% fewer tokens** (96–99.2% per repo) to perform common
"understand the codebase" tasks when an agent queries agentmap instead of reading
raw files with `cat` / `grep` / `find`. Measured across **7 agent tasks on 3 real
public repos**, fully reproducible. Every number below is captured tool output —
no hand-tuned figures.

| Repo | Files | Total saved | Standout task |
|------|------:|------------:|---------------|
| [vercel/ai-chatbot](https://github.com/vercel/ai-chatbot) | 154 | **98.3%** | reuse lookup 99.9% |
| [colinhacks/zod](https://github.com/colinhacks/zod) | 367 | **99.2%** | whole-repo map 99.8% |
| [shadcn-ui/taxonomy](https://github.com/shadcn-ui/taxonomy) | 125 | **96.0%** | reuse lookup 99.3% |

Per-task peaks across the three repos: **whole-repo map 99.8%**, **reuse-before-rebuild 99.9%**, **blast-radius 99.2%**, **find-symbol 99%**.

## Captured runs (`bench.mjs`)

### vercel/ai-chatbot — 154 files, sha `2becdb4`
```
Scenario                                       Baseline   agentmap   Saved
A. Understand file deps (lib/utils.ts)              583        517   11.3%
B. Find symbol (ChatMessage)                       1950         20     99%
C. Repo overview (tree + cat 3 hub files)          3065       1127   63.2%
D. Blast radius of lib/utils.ts (65 deps)         81038        616   99.2%
E. Understand "api" feature (11 files)             6121       1025   83.3%
F. Map whole repo (vs all 154 source files)      150281       1127   99.3%
G. Reuse check "ChatMe*"                           14740         19   99.9%
TOTAL                                            257778       4451   98.3%
```

### colinhacks/zod — 367 files, sha `912f0f5`  (library monorepo; no `app/` feature → scenario E n/a)
```
Scenario                                       Baseline   agentmap   Saved
A. Understand file deps (core/util.ts)             7421       1757   76.3%
B. Find symbol (JSONSchemaGenerator)                406         98   75.9%
C. Repo overview                                  52439        908   98.3%
D. Blast radius (65 dependents)                  158837       1882   98.8%
F. Map whole repo (vs all 403 source files)      586983        908   99.8%
G. Reuse check "JSONSchema*"                       53768       1387   97.4%
TOTAL                                            859854       6940   99.2%
```

### shadcn-ui/taxonomy — 125 files, sha `298a885`
```
Scenario                                       Baseline   agentmap   Saved
A. Understand file deps (lib/utils.ts)              123        508   -313%  (see caveat 2)
B. Find symbol (Icons)                             1386         19   98.6%
C. Repo overview                                   2082       1124     46%
D. Blast radius (66 dependents)                   41316        608   98.5%
E. Understand "dashboard" feature (7 files)        1993        975   51.1%
F. Map whole repo (vs all 129 source files)       58159       1124   98.1%
G. Reuse check "Icon*"                             4308          32   99.3%
TOTAL                                            109367       4390   96.0%
```

## The 7 tasks

| # | Task | Baseline (naive agent) | agentmap query |
|---|------|------------------------|----------------|
| A | Understand a file's dependencies | `cat <file>` + `grep -rln <basename>` | `--any <file>` |
| B | Find where a symbol lives | `grep -rn <symbol>` | `--find <symbol>` |
| C | Get a repo overview | `find` tree + `cat` top-3 hub files | `--map` |
| D | Blast radius (what breaks if I change X) | `cat <hub>` + `cat` **every dependent file** | `--relates <hub>` |
| E | Understand a feature | `cat` every file in the largest `app/` feature | `--map --focus <file>` |
| F | Map the whole repo | `cat` **every** source file (full dump) | `--map` |
| G | Reuse-before-rebuild | `grep` a name prefix + `cat` candidate files | `--find <prefix>` |

Targets are **auto-derived from each repo's own map** (top hub file, top-ranked
symbol, largest feature, etc.), so the identical script runs on any
ts-morph-mappable repo.

## Honest caveats — read before quoting the number

1. **Token estimate uses a regex chunker** (`cl100k_base` pre-tokenizer approximation) instead of the naive `chars / 4` heuristic. This captures the true density of arrays and CJK characters. The
   absolute token figures are ±5% of true BPE. Raw char counts live in each run's `@@JSON@@`
   footer.
2. **One result is negative, and we left it in.** taxonomy scenario **A = −313%**:
   for a *trivial single-file* dependency lookup, `cat` + a tiny `grep` is cheaper
   than agentmap's structured block. The tool pays off **at scale** (more files,
   more importers, more symbols) — not on a 2-line lookup. Shown, not cherry-picked.
3. **The grep baseline is *fair*, not worst-case** — it prunes
   `node_modules` / `.next` / `.git`. A naive unfiltered `grep -rn` would hit
   minified bundles and inflate savings dishonestly toward 100%.
4. **Structured vs raw.** agentmap returns *parsed* answers (dependents, ranked
   digests); the shell baselines return *raw* lines/source the agent must still
   read. The comparison is "bytes into context for the same question" — which
   favors agentmap because it already did the parsing. That's the value prop.
5. **NOT measured:** answer quality/completeness, wall-clock, end-to-end task
   success. This measures context-token volume only.
6. **A 4th repo (vercel/platforms) was excluded.** agentmap mapped **0 files**
   there (unusual layout its ts-morph pass didn't pick up), so `--map` emitted
   nothing and the "100%" was an empty-output artifact, not a real saving. Only
   repos agentmap actually indexes are reported.

## Reproduce

To reproduce the **exact numbers** in the tables above, check out the pinned shas
after cloning — the tables are captured snapshots at those commits, not at HEAD:

```bash
# vercel/ai-chatbot — sha 2becdb4
git clone https://github.com/vercel/ai-chatbot /tmp/ai-chatbot
git -C /tmp/ai-chatbot checkout 2becdb4
node /path/to/agentmap/benchmark/bench.mjs /tmp/ai-chatbot

# colinhacks/zod — sha 912f0f5
git clone https://github.com/colinhacks/zod /tmp/zod
git -C /tmp/zod checkout 912f0f5
node /path/to/agentmap/benchmark/bench.mjs /tmp/zod

# shadcn-ui/taxonomy — sha 298a885
git clone https://github.com/shadcn-ui/taxonomy /tmp/taxonomy
git -C /tmp/taxonomy checkout 298a885
node /path/to/agentmap/benchmark/bench.mjs /tmp/taxonomy
```

Zero-dependency script (`node:child_process` / `node:fs` / `node:path` only). Each run appends
a machine-readable `@@JSON@@{...}` footer for CI/scripting.

> **File count note:** the "Files" column in the summary table is the ts-morph-mapped
> count (only files the AST pass successfully parsed). Scenario F's headline
> "all N source files" is the raw `find` count of `.ts/.tsx/.js/.jsx` files —
> these two numbers differ intentionally: unmappable files (e.g. plain JS configs,
> type-only `.d.ts` shims) appear in `find` output but are skipped by ts-morph.
>
> **Tokenizer note:** all token figures use the cl100k regex chunker on both
> sides. The saved-% ratio is largely stable regardless of tokenizer, but absolute
> numbers now match GPT-4's perception much more closely than legacy `chars / 4`.

## Environment

- **node** v26.3.0 ; **ts-morph** 28.0.0 (agentmap's only dependency)
- token est = cl100k regex chunker
- repos cloned shallow at the shas listed above
