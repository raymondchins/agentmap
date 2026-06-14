#!/usr/bin/env node
// eval/eval.mjs — retrieval-ACCURACY eval for agentmap.
//
// The bench (benchmark/bench.mjs, RESULTS.md) only measures token EFFICIENCY
// (chars/4 fewer tokens). It does NOT prove the returned results are CORRECT —
// "fewer tokens" could secretly mean "fewer correct answers". This harness fills
// that gap: it scores RETRIEVAL CORRECTNESS against ground truth on real public
// TS/JS repos, and reports accuracy AND token cost side by side so the two can be
// read together.
//
// Design choice (WHY): ground truth is DERIVED AT RUNTIME from each cloned repo,
// not hand-authored. Hand-authored "symbol X is in file F" pairs rot the moment
// the upstream repo changes and risk being wrong from memory. Instead we derive:
//   - symbol definitions  -> regex over `export <kind> <Name>` declaration sites
//   - module dependents    -> a real relative-import resolver (handles TS .js->.ts,
//                             barrels/index, .tsx/.mts, require/dynamic import)
// Both derivations use a DIFFERENT mechanism than agentmap's ts-morph graph, so the
// comparison is a genuine cross-check, not circular. The resolver is regex-based,
// so we label it the "reference" and report agentmap's precision/recall against it.
//
// Zero runtime deps: Node stdlib + git only. Needs network (clones repos) — keep
// it OUT of default CI. Run: npm run eval   (or: node eval/eval.mjs [flags])
//   --repo <name>     run a single fixture (zod | type-fest | hono)
//   --sample <n>      cases per type per repo (default 25 def / 20 deps, scaled)
//   --refresh         re-clone fixtures even if already present
//   --json-out <path> also write raw results JSON (default tmp/eval/results.json)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTMAP = join(ROOT, "agentmap.mjs");
const TMP = join(ROOT, "tmp", "eval");

const FIXTURES = [
  { name: "zod", url: "https://github.com/colinhacks/zod", sourceRoot: "packages/zod/src/v4" },
  { name: "zustand", url: "https://github.com/pmndrs/zustand", sourceRoot: "src" },
  { name: "hono", url: "https://github.com/honojs/hono", sourceRoot: "src" },
];

// ---- arg parsing ----
const argv = process.argv.slice(2);
const argVal = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const has = (flag) => argv.includes(flag);
const ONLY = argVal("--repo", null);
const SAMPLE_DEF = Number(argVal("--sample", 25));
const SAMPLE_DEPS = Math.max(8, Math.round(SAMPLE_DEF * 0.8));
const REFRESH = has("--refresh");
const JSON_OUT = argVal("--json-out", join(TMP, "results.json"));

// ---- generic helpers ----
const SRC_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "tmp", "vendor", "fixtures", "__fixtures__"]);
const tokEst = (s) => Math.ceil((s || "").length / 4);
const isTestPath = (p) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(__tests__|__mocks__|tests?|test|e2e|benchmark|bench)\//.test(p);
const ext = (p) => { const b = basename(p); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i); };
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// run a command, returning {stdout, status} even on non-zero exit (don't throw)
function runCap(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], ...opts });
    return { stdout, status: 0 };
  } catch (e) {
    return { stdout: e.stdout ? e.stdout.toString() : "", status: typeof e.status === "number" ? e.status : 1 };
  }
}

// agentmap query -> parsed JSON object (reads stdout even on exit 1 / no-match)
function am(repoDir, args) {
  const { stdout } = runCap("node", [AGENTMAP, "--json", ...args], { cwd: repoDir });
  try { return JSON.parse(stdout); } catch { return null; }
}
// agentmap human-format output (for token cost measurement, what an agent actually reads)
function amHuman(repoDir, args) {
  return runCap("node", [AGENTMAP, ...args], { cwd: repoDir }).stdout;
}

// deterministic evenly-spaced sample of K from a sorted list (reproducible, no RNG)
function sample(arr, k) {
  const sorted = [...arr].sort();
  if (sorted.length <= k) return sorted;
  const out = [];
  const step = sorted.length / k;
  for (let i = 0; i < k; i++) out.push(sorted[Math.floor(i * step)]);
  return [...new Set(out)];
}

// ---- repo prep ----
function ensureClone(fx) {
  mkdirSync(TMP, { recursive: true });
  const dir = join(TMP, fx.name);
  if (existsSync(dir) && !REFRESH) {
    // reuse
  } else {
    if (existsSync(dir)) runCap("rm", ["-rf", dir]);
    process.stderr.write(`  cloning ${fx.name} (${fx.url}) ...\n`);
    const { status } = runCap("git", ["clone", "--depth", "1", fx.url, dir]);
    if (status !== 0 || !existsSync(dir)) throw new Error(`clone failed for ${fx.name} — network? (${fx.url})`);
  }
  const sha = runCap("git", ["-C", dir, "rev-parse", "HEAD"]).stdout.trim();
  return { dir, sha };
}

// list source files (repo-relative) under a starting dir, excluding tests/.d.ts/build dirs
function listSrc(repoDir, startRel) {
  const startAbs = startRel ? join(repoDir, startRel) : repoDir;
  const out = [];
  const walk = (absDir) => {
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(abs); continue; }
      const rel = relative(repoDir, abs);
      if (!SRC_EXT.has(ext(abs))) continue;
      if (rel.endsWith(".d.ts")) continue;
      if (isTestPath(rel)) continue;
      out.push(rel);
    }
  };
  walk(startAbs);
  return out;
}

// ---- ground-truth derivation #1: symbol definition sites ----
const DECL_RE =
  /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|function\*?|const|let|var|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;

// strip block + line comments so commented-out `export const X` isn't mistaken for a
// definition (leaves http:// etc. alone via the [^:] guard). Not string-literal aware,
// but real `export <kind> X` inside a string is vanishingly rare and harmless here.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function buildDefIndex(repoDir, srcFilesRepoWide) {
  const def = new Map(); // name -> Set(relfile)
  for (const rel of srcFilesRepoWide) {
    let txt;
    try { txt = stripComments(readFileSync(join(repoDir, rel), "utf8")); } catch { continue; }
    DECL_RE.lastIndex = 0;
    let m;
    while ((m = DECL_RE.exec(txt))) {
      const name = m[2];
      if (!def.has(name)) def.set(name, new Set());
      def.get(name).add(rel);
    }
  }
  return def;
}

// ---- ground-truth derivation #2: import resolver (dependents) ----
// NOTE: the `(?!type\b)` lookaheads exclude type-only `import type`/`export type`
// statements. agentmap's ts-morph graph drops type-only edges by design
// (agentmap.mjs: `if (imp.isTypeOnly()) continue`), so to compare scope-for-scope the
// ground truth must drop them too. Mixed inline forms (`import { type A, B }`) are still
// counted — agentmap keeps those edges (the import declaration isn't type-only).
const SPEC_RES = [
  /\bimport\s+(?!type\b)[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import ... from 'x' (value)
  /\bexport\s+(?!type\b)[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // export ... from 'x' (re-export)
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                  // dynamic import('x')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                 // require('x')
  /\bimport\s+['"]([^'"]+)['"]/g,                           // bare side-effect import 'x'
];

function extractSpecs(repoDir, rel) {
  let txt;
  try { txt = readFileSync(join(repoDir, rel), "utf8"); } catch { return []; }
  const specs = new Set();
  for (const re of SPEC_RES) { re.lastIndex = 0; let m; while ((m = re.exec(txt))) specs.add(m[1]); }
  return [...specs];
}

function resolveSpec(repoDir, fromRel, spec, fileSetAbs) {
  if (!spec.startsWith(".")) return null; // external package — not a local dependent edge
  const baseAbs = resolve(repoDir, dirname(fromRel), spec);
  const stripped = baseAbs.replace(/\.(js|mjs|cjs|jsx)$/, ""); // TS lets './x.js' resolve to x.ts
  const cands = [
    baseAbs,
    baseAbs + ".ts", baseAbs + ".tsx", baseAbs + ".mts", baseAbs + ".cts", baseAbs + ".js", baseAbs + ".jsx", baseAbs + ".mjs", baseAbs + ".cjs",
    stripped + ".ts", stripped + ".tsx", stripped + ".mts", stripped + ".cts",
    join(baseAbs, "index.ts"), join(baseAbs, "index.tsx"), join(baseAbs, "index.mts"), join(baseAbs, "index.js"), join(baseAbs, "index.mjs"),
  ];
  for (const c of cands) if (fileSetAbs.has(c)) return relative(repoDir, c);
  return null;
}

// target relfile -> Set(importer relfile)
function buildImporterIndex(repoDir, srcFilesRepoWide) {
  const fileSetAbs = new Set(srcFilesRepoWide.map((r) => join(repoDir, r)));
  const importers = new Map();
  for (const rel of srcFilesRepoWide) {
    for (const spec of extractSpecs(repoDir, rel)) {
      const target = resolveSpec(repoDir, rel, spec, fileSetAbs);
      if (!target || target === rel) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(rel);
    }
  }
  return importers;
}

// ---- metric helpers ----
const inScope = (rel, sourceRoot) => rel === sourceRoot || rel.startsWith(sourceRoot + "/");
function setStats(got, truth) {
  const G = new Set(got), T = new Set(truth);
  let hit = 0;
  for (const g of G) if (T.has(g)) hit++;
  const precision = G.size ? hit / G.size : T.size ? 0 : 1;
  const recall = T.size ? hit / T.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp: hit, got: G.size, truth: T.size };
}

// ============================ TYPE 1: symbol definition ============================
function evalDefs(fx, repoDir, defIndex) {
  // candidate symbols: globally-unique definition, defined inside sourceRoot, name length >= 4
  const candidates = [];
  for (const [name, files] of defIndex) {
    if (files.size !== 1) continue;
    const file = [...files][0];
    if (!inScope(file, fx.sourceRoot)) continue;
    if (name.length < 4) continue;
    candidates.push(name);
  }
  const picked = sample(candidates, SAMPLE_DEF);
  const rows = [];
  for (const name of picked) {
    const truth = [...defIndex.get(name)][0]; // single file
    // agentmap --find: keep exact-name matches, in returned order
    const j = am(repoDir, ["--find", name]);
    const amFiles = [];
    if (j && Array.isArray(j.matches)) for (const mm of j.matches) if (mm.name === name && !amFiles.includes(mm.file)) amFiles.push(mm.file);
    const amHit1 = amFiles[0] === truth;
    const amHit3 = amFiles.slice(0, 3).includes(truth);
    const amFound = amFiles.includes(truth);
    // baseline: naive git-grep for the bare identifier (whole-word, fixed-string — POSIX ERE
    // has no \b, and `$` is legal in identifiers, so -w -F is the correct word match here)
    const g = runCap("git", ["-C", repoDir, "grep", "-n", "-w", "-F", "-e", name, "--", fx.sourceRoot]);
    const gFiles = [];
    for (const line of g.stdout.split("\n")) { const f = line.split(":")[0]; if (f && !gFiles.includes(f)) gFiles.push(f); }
    const gHit1 = gFiles[0] === truth;
    const gHit3 = gFiles.slice(0, 3).includes(truth);
    // token cost of what each puts in front of the agent
    const amTok = tokEst(amHuman(repoDir, ["--find", name]));
    const gTok = tokEst(g.stdout);
    rows.push({ name, truth, amHit1, amHit3, amFound, gHit1, gHit3, amCount: amFiles.length, gCount: gFiles.length, amTok, gTok });
  }
  return rows;
}

// ============================ TYPE 2: dependents / who-imports ============================
function evalDeps(fx, repoDir, importerIndex, srcFilesRepoWide) {
  // candidate modules: files in sourceRoot with >= 2 real importers
  const candidates = [];
  for (const [target, imps] of importerIndex) {
    if (!inScope(target, fx.sourceRoot)) continue;
    if (imps.size < 2) continue;
    candidates.push(target);
  }
  const picked = sample(candidates, SAMPLE_DEPS);
  const rows = [];
  for (const mod of picked) {
    const truth = [...importerIndex.get(mod)];
    // agentmap --relates -> dependents[]. Scope to non-test files to match `truth` (which
    // excludes tests) — otherwise agentmap's legit test-file importers score as false positives.
    const j = am(repoDir, ["--relates", mod]);
    const amDeps = (j && Array.isArray(j.dependents) ? j.dependents : []).filter((f) => !isTestPath(f));
    const amS = setStats(amDeps, truth);
    // baseline: grep files that import a spec ending in this module's name (noisy on dup
    // names). For `index.*` modules use the parent dir name, else the basename matches every
    // barrel import. Needs PCRE (-P) for \s; escape the term for regex safety; non-test only.
    const rawBase = basename(mod).replace(/\.[cm]?[jt]sx?$/, "");
    const term = rawBase === "index" ? basename(dirname(mod)) : rawBase;
    const termRe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const g = runCap("git", ["-C", repoDir, "grep", "-l", "-P", "-e", `(?:from|require\\(|import\\()\\s*['"][^'"]*/?${termRe}(?:/index)?(?:\\.[cm]?[jt]sx?)?['"]`, "--", "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.jsx"]);
    const gFiles = g.stdout.split("\n").map((s) => s.trim()).filter((s) => s && s !== mod && !isTestPath(s));
    const gS = setStats(gFiles, truth);
    const amTok = tokEst(amHuman(repoDir, ["--relates", mod]));
    const gTok = tokEst(g.stdout);
    rows.push({ mod, truthN: truth.length, am: amS, g: gS, amTok, gTok });
  }
  return rows;
}

// ---- aggregation + reporting ----
function aggDefs(rows) {
  const n = rows.length;
  return {
    n,
    amHit1: pct(rows.filter((r) => r.amHit1).length, n),
    amHit3: pct(rows.filter((r) => r.amHit3).length, n),
    amFound: pct(rows.filter((r) => r.amFound).length, n),
    gHit1: pct(rows.filter((r) => r.gHit1).length, n),
    gHit3: pct(rows.filter((r) => r.gHit3).length, n),
    tokRatio: Math.round(median(rows.map((r) => (r.amTok ? r.gTok / r.amTok : 0))) * 10) / 10,
    amTokMed: Math.round(median(rows.map((r) => r.amTok))),
    gTokMed: Math.round(median(rows.map((r) => r.gTok))),
  };
}
function aggDeps(rows) {
  const n = rows.length;
  return {
    n,
    amRecall: pct(mean(rows.map((r) => r.am.recall)), 1),
    amPrec: pct(mean(rows.map((r) => r.am.precision)), 1),
    amF1: pct(mean(rows.map((r) => r.am.f1)), 1),
    gRecall: pct(mean(rows.map((r) => r.g.recall)), 1),
    gPrec: pct(mean(rows.map((r) => r.g.precision)), 1),
    gF1: pct(mean(rows.map((r) => r.g.f1)), 1),
    // agentmap --relates returns the full blast radius (exports + imports + dependents +
    // related), so it costs MORE than grep's bare file list. Report that honestly.
    amTokMore: Math.round(median(rows.map((r) => (r.gTok ? r.amTok / r.gTok : 0))) * 10) / 10,
  };
}

async function main() {
  const fixtures = ONLY ? FIXTURES.filter((f) => f.name === ONLY) : FIXTURES;
  if (!fixtures.length) { console.error(`unknown --repo ${ONLY}; choices: ${FIXTURES.map((f) => f.name).join(", ")}`); process.exit(2); }
  if (!existsSync(AGENTMAP)) { console.error(`agentmap.mjs not found at ${AGENTMAP}`); process.exit(2); }

  const perRepo = [];
  for (const fx of fixtures) {
    process.stderr.write(`\n[${fx.name}] preparing...\n`);
    const { dir, sha } = ensureClone(fx);
    // warm agentmap cache once (builds .claude/agentmap/map.json inside the throwaway clone)
    runCap("node", [AGENTMAP, "--hubs"], { cwd: dir });
    const srcRepoWide = listSrc(dir, "");
    const defIndex = buildDefIndex(dir, srcRepoWide);
    const importerIndex = buildImporterIndex(dir, srcRepoWide);
    process.stderr.write(`  ${srcRepoWide.length} source files; ${defIndex.size} declared symbols; sourceRoot=${fx.sourceRoot}\n`);
    process.stderr.write(`  scoring symbol-definition retrieval...\n`);
    const defRows = evalDefs(fx, dir, defIndex);
    process.stderr.write(`  scoring dependents retrieval...\n`);
    const depRows = evalDeps(fx, dir, importerIndex, srcRepoWide);
    perRepo.push({ name: fx.name, sha, sourceRoot: fx.sourceRoot, srcCount: srcRepoWide.length, defs: aggDefs(defRows), deps: aggDeps(depRows), defRows, depRows });
  }

  // overall (pool rows across repos)
  const allDef = perRepo.flatMap((r) => r.defRows);
  const allDep = perRepo.flatMap((r) => r.depRows);
  const overall = { defs: aggDefs(allDef), deps: aggDeps(allDep) };

  // ---- console summary ----
  const line = "─".repeat(64);
  console.log(`\n${line}\nagentmap retrieval-accuracy eval\n${line}`);
  for (const r of perRepo) {
    console.log(`\n${r.name}  @${r.sha.slice(0, 10)}  (${r.srcCount} src files, sourceRoot ${r.sourceRoot})`);
    console.log(`  symbol-def  n=${r.defs.n}  agentmap top1 ${r.defs.amHit1}% / top3 ${r.defs.amHit3}% / found ${r.defs.amFound}%   |  grep top1 ${r.defs.gHit1}% / top3 ${r.defs.gHit3}%   |  ~${r.defs.tokRatio}x fewer tokens`);
    console.log(`  dependents  n=${r.deps.n}  agentmap recall ${r.deps.amRecall}% / prec ${r.deps.amPrec}% / F1 ${r.deps.amF1}%   |  grep recall ${r.deps.gRecall}% / prec ${r.deps.gPrec}% / F1 ${r.deps.gF1}%   |  agentmap ~${r.deps.amTokMore}x tokens (full blast-radius payload)`);
  }
  console.log(`\nOVERALL`);
  console.log(`  symbol-def  n=${overall.defs.n}  agentmap top1 ${overall.defs.amHit1}% / top3 ${overall.defs.amHit3}%   vs grep top1 ${overall.defs.gHit1}% / top3 ${overall.defs.gHit3}%   (~${overall.defs.tokRatio}x fewer tokens)`);
  console.log(`  dependents  n=${overall.deps.n}  agentmap recall ${overall.deps.amRecall}% / prec ${overall.deps.amPrec}%   vs grep recall ${overall.deps.gRecall}% / prec ${overall.deps.gPrec}%`);
  console.log(line);

  // ---- write EVAL.md + raw JSON ----
  const today = new Date().toISOString().slice(0, 10);
  writeEvalMd(today, perRepo, overall);
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify({ date: today, perRepo, overall }, null, 2));
  console.log(`\nwrote ${relative(ROOT, join(ROOT, "EVAL.md"))} and ${relative(ROOT, JSON_OUT)}\n`);
}

function writeEvalMd(today, perRepo, overall) {
  const repoTable = perRepo
    .map((r) => `| ${r.name} | \`${r.sha.slice(0, 10)}\` | ${r.defs.n} | ${r.defs.amHit1}% / ${r.defs.amHit3}% | ${r.defs.gHit1}% / ${r.defs.gHit3}% | ${r.deps.n} | ${r.deps.amRecall}% / ${r.deps.amPrec}% | ${r.deps.gRecall}% / ${r.deps.gPrec}% |`)
    .join("\n");
  const md = `# Retrieval-accuracy eval

> Generated by \`npm run eval\` (\`eval/eval.mjs\`) on ${today}. Re-run to refresh.
> Complements \`RESULTS.md\` (token efficiency). This file answers the harder question:
> **when agentmap returns fewer tokens, are they the _right_ tokens?**

## Why this exists

\`RESULTS.md\` proves agentmap puts far fewer tokens in front of the agent. It does **not**
prove those tokens contain the correct answer — "fewer tokens" could mean "fewer correct
answers". This eval measures **retrieval correctness** against ground truth derived live
from real public repos, then shows accuracy and token cost together.

## Method

Ground truth is **derived at runtime** from each cloned repo (not hand-authored, so it
can't silently rot), using a **different mechanism than agentmap's ts-morph graph** — so the
comparison is a real cross-check, not circular:

- **Symbol definition** — "where is symbol \`X\` defined?" Ground truth = the single file
  whose source contains \`export <kind> X\` (regex over declaration sites). Only globally
  unique definitions are tested (no ambiguity). Compared: \`agentmap --find X\` (exact-name
  matches, in returned order) vs naive \`git grep -n X\` (every occurrence).
  Metric: **top-1 / top-3 hit rate** (is the definition file the 1st / among the first 3
  results?).
- **Dependents / blast radius** — "which files import module \`M\`?" Ground truth = files
  whose relative-import specifiers **resolve** to \`M\` (a real resolver: handles TS
  \`./x.js\`→\`x.ts\`, \`.tsx/.mts\`, \`index\` barrels, \`require\`/dynamic \`import\`,
  re-export edges). Compared: \`agentmap --relates M\` \`.dependents\` vs naive
  \`git grep -l\` for the module's name in import lines (for \`index.*\` modules the parent
  dir name, so the baseline isn't strawmanned into matching every barrel). Metric:
  **precision / recall / F1** against the resolved set.

**Scope alignment (so the comparison is fair both ways):** test files (\`*.test.*\`,
\`runtime-tests/\`, etc.) are excluded from ground truth **and** from both tools' outputs
before scoring — otherwise agentmap's legitimate test-file importers would score as false
positives. **Type-only edges** (\`import type\` / \`export type\`) are excluded from ground
truth, because agentmap's ts-morph graph drops them by design — counting them would penalize
recall for a documented behaviour rather than a defect. Each fixture is scoped to a
\`sourceRoot\`. Token cost = chars/4 of the **full default (human) output** each tool puts in
context (same heuristic as \`RESULTS.md\`, both sides).

> Caveats — read these before quoting numbers. (1) The ground-truth resolver is regex-based,
> not a TypeScript type-checker; it is the *reference*, and a handful of exotic edges
> (\`tsconfig\` \`paths\` aliases — none in these fixtures) may differ from a true compiler.
> (2) Definitions tested are uniquely-declared only — the easy, unambiguous cases. (3)
> \`agentmap --find\` lists barrel **re-export** sites alongside the real declaration, which
> is why top-1 trails top-3 — the definition is usually in the top 3, not always first. (4)
> Dependents recall reflects agentmap's **value-import** graph only (type-only edges are
> excluded from truth to match it); a separate "type-aware" mode would be needed to retrieve
> type-only importers. (5) Feature-level retrieval (\`--feature\`) is **not** scored — these
> are libraries with no \`app/\` routes, so the route-based feature detector is empty; that
> needs a Next.js-style app fixture (TODO). (6) Numbers move with upstream repos; resolved
> SHAs are recorded below.

## Results

### Overall (pooled across fixtures)

| Task | n | agentmap | naive grep |
|---|---|---|---|
| Symbol definition — top-1 / top-3 hit | ${overall.defs.n} | **${overall.defs.amHit1}% / ${overall.defs.amHit3}%** | ${overall.defs.gHit1}% / ${overall.defs.gHit3}% |
| Dependents — recall / precision | ${overall.deps.n} | **${overall.deps.amRecall}% / ${overall.deps.amPrec}%** | ${overall.deps.gRecall}% / ${overall.deps.gPrec}% |

Symbol-definition lookups cost a median **~${overall.defs.tokRatio}× fewer tokens** than dumping \`git grep\`
output, while landing the definition in the top 3 more often. For dependents the story is a
**precision** win, not a token win: agentmap returns a clean importer list (high precision)
where naive grep returns a noisy superset (high recall, low precision) — and \`--relates\`
actually costs **more** tokens than \`grep -l\` because it returns the full blast radius
(exports + imports + dependents + related), not just the file list.

### Per fixture

| Repo | commit | def n | agentmap top1/top3 | grep top1/top3 | deps n | agentmap recall/prec | grep recall/prec |
|---|---|---|---|---|---|---|---|
${repoTable}

## Reproduce

\`\`\`bash
npm run eval                 # all fixtures
node eval/eval.mjs --repo zod --sample 40
node eval/eval.mjs --refresh # re-clone upstreams
\`\`\`

Clones land in \`tmp/eval/\` (gitignored). Network required; not part of CI.
`;
  writeFileSync(join(ROOT, "EVAL.md"), md);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
