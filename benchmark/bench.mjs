#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ============================================================================
//  bench.mjs — reproducible token-savings benchmark for agentmap.
//
//  Compares the BYTES an agent would have to read into context for three
//  common "understand the codebase" tasks, using a naive shell baseline vs
//  the equivalent agentmap query. Token estimate = chars / 4 (same rough
//  heuristic agentmap itself uses; see the caveat in RESULTS.md).
//
//  Zero deps (only node:child_process / node:path). Targets are auto-derived
//  from the repo (top hub file, top-ranked symbol, hub files for overview),
//  so it is reproducible on ANY ts-morph-mappable repo.
//
//  Usage:  node benchmark/bench.mjs [<target-repo-path>]
//          (defaults to cwd; agentmap itself is resolved next to this file)
// ============================================================================
import { execSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(process.argv[2] || process.cwd());
const AGENTMAP = join(dirname(dirname(fileURLToPath(import.meta.url))), "agentmap.mjs");

const tok = (s) => Math.ceil((s || "").length / 4); // chars/4 — see RESULTS.md caveat
const pct = (base, tool) => base === 0 ? 0 : Math.round(((base - tool) / base) * 1000) / 10;

// Source-file grep that mirrors a COMPETENT agent: prunes build/vendor dirs so
// the baseline isn't inflated by minified bundles in node_modules/.next. (A
// naive `grep -rn` without these would balloon the baseline ~1000x and make the
// savings dishonestly large.) --include filters filenames; --exclude-dir prunes.
const SRC_GREP = `grep -rn --include=*.ts --include=*.tsx --include=*.js --include=*.jsx --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git`;

// run a shell command in the target repo; return stdout (empty string on error)
function sh(cmd) {
  try { return execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { return e.stdout ? e.stdout.toString() : ""; }
}
// run agentmap with given flags in the target repo
function agentmap(flags) {
  try { return execFileSync("node", [AGENTMAP, ...flags], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { return e.stdout ? e.stdout.toString() : ""; }
}

// ---- derive targets from the repo's own map (so the bench is repo-agnostic) ----
function jsonMap() {
  const raw = agentmap(["--print"]);
  try { return JSON.parse(raw.trim().split("\n").pop()); } catch { return { hubs: [], files: {}, rankedSymbols: [] }; }
}
const map = jsonMap();
// top hub file: first hub line is "path (deg N, pr X)"
const hubFiles = (map.hubs || []).map((h) => h.split(" ")[0]).filter(Boolean);
const HUB_FILE = hubFiles[0];
// a top-ranked exported symbol that isn't a one-letter/too-generic name
const SYM = (map.rankedSymbols || []).map((s) => s.name).find((n) => n && n.length >= 5 && /^[A-Za-z][A-Za-z0-9_]*$/.test(n));
// top 3 hub files for the "overview" scenario
const OVERVIEW_FILES = hubFiles.slice(0, 3);
// dependents of the top hub (blast-radius), the largest feature (deep-dive),
// and a name-prefix (reuse-before-rebuild) — all derived from the map.
const DEPENDENTS = (map.files?.[HUB_FILE]?.dependents) || [];
const FEATURE = Object.entries(map.features || {}).sort((a, b) => b[1].length - a[1].length)[0] || null;
const FEATURE_FILES = FEATURE ? FEATURE[1] : [];
const FEATURE_FOCUS = FEATURE_FILES[0];
const REUSE_PREFIX = SYM ? SYM.slice(0, Math.max(4, Math.ceil(SYM.length / 2))) : null;

// =====================================================================
//  Scenario A — "understand a file's dependencies"
//    baseline: cat the file + grep the repo for who imports it
//    agentmap: --any <file>  (exports + imports + dependents, no source)
// =====================================================================
function scenarioA() {
  if (!HUB_FILE) return null;
  // readFileSync avoids a shell subprocess (no injection surface for hostile filenames)
  let fileContent = "";
  try { fileContent = readFileSync(join(REPO, HUB_FILE), "utf8"); } catch {}
  // grep for files importing the hub — argv form: no shell, repo paths cannot inject
  const basename = HUB_FILE.split("/").pop();
  let grepOut = "";
  try {
    grepOut = execFileSync("grep", [
      "-rln", "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx",
      "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=.git",
      basename, ".",
    ], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { grepOut = e.stdout ? e.stdout.toString() : ""; }
  const base = fileContent + grepOut;
  const tool = agentmap(["--any", HUB_FILE]);
  return { name: `A. Understand file deps (${HUB_FILE})`,
    baselineCmd: `cat ${HUB_FILE} + grep -rln <basename> .`,
    toolCmd: `agentmap.mjs --any ${HUB_FILE}`,
    base: tok(base), tool: tok(tool), baseChars: base.length, toolChars: tool.length };
}

// =====================================================================
//  Scenario B — "find where a symbol is defined/used"
//    baseline: grep -rn <symbol> across the repo
//    agentmap: --find <symbol>  (definition site(s) only)
// =====================================================================
function scenarioB() {
  if (!SYM) return null;
  // argv form — SYM is passed as a literal argument, never interpolated into a shell string
  let base = "";
  try {
    base = execFileSync("grep", [
      "-rn", "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx",
      "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=.git",
      SYM, ".",
    ], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { base = e.stdout ? e.stdout.toString() : ""; }
  const tool = agentmap(["--find", SYM]);
  return { name: `B. Find symbol (${SYM})`,
    baselineCmd: `grep -rn ${SYM} .`,
    toolCmd: `agentmap.mjs --find ${SYM}`,
    base: tok(base), tool: tok(tool), baseChars: base.length, toolChars: tool.length };
}

// =====================================================================
//  Scenario C — "get a repo overview to start working"
//    baseline: file tree (ls -R, no node_modules/.next) + cat top hub files
//    agentmap: --map  (token-budgeted ranked symbol digest)
// =====================================================================
function scenarioC() {
  // find uses no repo-controlled arguments (no injection surface)
  const tree = sh(`find . -type d \\( -name node_modules -o -name .next -o -name .git \\) -prune -o -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \\) -print`);
  let cats = "";
  // readFileSync: hub file paths come from agentmap's own map, but use safe FS read anyway
  for (const f of OVERVIEW_FILES) {
    try { cats += readFileSync(join(REPO, f), "utf8"); } catch {}
  }
  const base = tree + cats;
  const tool = agentmap(["--map"]);
  return { name: `C. Repo overview (tree + cat ${OVERVIEW_FILES.length} hub files)`,
    baselineCmd: `find . -name '*.ts*' + cat ${OVERVIEW_FILES.length} hub files`,
    toolCmd: `agentmap.mjs --map`,
    base: tok(base), tool: tok(tool), baseChars: base.length, toolChars: tool.length };
}

// =====================================================================
//  Scenario D — "blast radius: what breaks if I change this hub?"
//    baseline: cat the hub + cat EVERY file that imports it
//    agentmap: --relates <hub>  (dependents + transitive relevance)
// =====================================================================
function scenarioD() {
  if (!HUB_FILE || DEPENDENTS.length < 3) return null;
  // readFileSync: safe FS read, no shell injection surface
  let cats = "";
  try { cats = readFileSync(join(REPO, HUB_FILE), "utf8"); } catch {}
  for (const f of DEPENDENTS) {
    try { cats += readFileSync(join(REPO, f), "utf8"); } catch {}
  }
  const tool = agentmap(["--relates", HUB_FILE]);
  return { name: `D. Blast radius of ${HUB_FILE} (read its ${DEPENDENTS.length} dependents)`,
    baselineCmd: `cat ${HUB_FILE} + cat its ${DEPENDENTS.length} dependents`,
    toolCmd: `agentmap.mjs --relates ${HUB_FILE}`,
    base: tok(cats), tool: tok(tool), baseChars: cats.length, toolChars: tool.length };
}

// =====================================================================
//  Scenario E — "understand a feature before touching it"
//    baseline: cat every file in the largest app/ feature
//    agentmap: --map --focus <feature file>  (ranked digest, personalized)
// =====================================================================
function scenarioE() {
  if (FEATURE_FILES.length < 3) return null;
  // readFileSync: safe FS read, no shell injection surface
  let cats = "";
  for (const f of FEATURE_FILES) {
    try { cats += readFileSync(join(REPO, f), "utf8"); } catch {}
  }
  const tool = agentmap(["--map", "--focus", FEATURE_FOCUS]);
  return { name: `E. Understand "${FEATURE[0]}" feature (read its ${FEATURE_FILES.length} files)`,
    baselineCmd: `cat all ${FEATURE_FILES.length} files of feature "${FEATURE[0]}"`,
    toolCmd: `agentmap.mjs --map --focus ${FEATURE_FOCUS}`,
    base: tok(cats), tool: tok(tool), baseChars: cats.length, toolChars: tool.length };
}

// =====================================================================
//  Scenario F — "map the whole repo" (the extreme case)
//    baseline: cat EVERY source file (a full-repo dump)
//    agentmap: --map  (one ranked, token-budgeted digest)
// =====================================================================
function scenarioF() {
  // find uses no repo-controlled args; output paths are then read via readFileSync (no shell)
  const list = sh(`find . -type d \\( -name node_modules -o -name .next -o -name .git \\) -prune -o -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \\) -print`).split("\n").filter(Boolean);
  if (!list.length) return null;
  let cats = "";
  // list entries are "./rel/path" from find; resolve each against REPO
  for (const f of list) {
    try { cats += readFileSync(join(REPO, f), "utf8"); } catch {}
  }
  const tool = agentmap(["--map"]);
  return { name: `F. Map whole repo (vs dumping all ${list.length} source files)`,
    baselineCmd: `cat all ${list.length} source files`,
    toolCmd: `agentmap.mjs --map`,
    base: tok(cats), tool: tok(tool), baseChars: cats.length, toolChars: tool.length };
}

// =====================================================================
//  Scenario G — "reuse-before-rebuild: is there already a helper for X?"
//    baseline: grep the name prefix + cat the candidate files to inspect
//    agentmap: --find <prefix>  (every matching exported symbol, one line each)
// =====================================================================
function scenarioG() {
  if (!REUSE_PREFIX) return null;
  // argv form — REUSE_PREFIX is derived from SYM (a symbol name), passed as a literal arg
  let grep = "";
  try {
    grep = execFileSync("grep", [
      "-rln", "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx",
      "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=.git",
      REUSE_PREFIX, ".",
    ], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { grep = e.stdout ? e.stdout.toString() : ""; }
  const candidates = grep.split("\n").filter(Boolean).slice(0, 8);
  // readFileSync: safe FS read for candidate files
  let cats = "";
  for (const f of candidates) {
    try { cats += readFileSync(join(REPO, f), "utf8"); } catch {}
  }
  const base = grep + cats;
  const tool = agentmap(["--find", REUSE_PREFIX]);
  return { name: `G. Reuse check "${REUSE_PREFIX}*" (grep + read ${candidates.length} candidates)`,
    baselineCmd: `grep -rl ${REUSE_PREFIX} + cat ${candidates.length} candidate files`,
    toolCmd: `agentmap.mjs --find ${REUSE_PREFIX}`,
    base: tok(base), tool: tok(tool), baseChars: base.length, toolChars: tool.length };
}

// ---------------------------------------------------------------------------
const rows = [scenarioA(), scenarioB(), scenarioC(), scenarioD(), scenarioE(), scenarioF(), scenarioG()].filter(Boolean);

// environment line
const nodeV = process.version;
const fileCount = map.fileCount ?? Object.keys(map.files || {}).length; // map.fileCount is always present now (--print includes it)
let sha = "";
try { sha = execSync("git rev-parse --short HEAD", { cwd: REPO, encoding: "utf8" }).trim(); } catch {}

const totBase = rows.reduce((a, r) => a + r.base, 0);
const totTool = rows.reduce((a, r) => a + r.tool, 0);

// ---- render ----
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`agentmap token-savings benchmark`);
console.log(`repo: ${REPO}`);
console.log(`env:  node ${nodeV}, ${fileCount} mapped files, HEAD ${sha || "n/a"}`);
console.log(`est:  tokens = chars / 4\n`);

const W = { s: 42, b: 12, t: 12, sv: 9 };
console.log(`${pad("Scenario", W.s)}${lpad("Baseline tok", W.b)}${lpad("agentmap tok", W.t)}${lpad("Saved %", W.sv)}`);
console.log("-".repeat(W.s + W.b + W.t + W.sv));
for (const r of rows) {
  console.log(`${pad(r.name.slice(0, W.s - 1), W.s)}${lpad(r.base, W.b)}${lpad(r.tool, W.t)}${lpad(pct(r.base, r.tool) + "%", W.sv)}`);
}
console.log("-".repeat(W.s + W.b + W.t + W.sv));
console.log(`${pad("TOTAL", W.s)}${lpad(totBase, W.b)}${lpad(totTool, W.t)}${lpad(pct(totBase, totTool) + "%", W.sv)}`);

console.log(`\nper-scenario commands (run in ${REPO}):`);
for (const r of rows) {
  console.log(`  [${r.name.split(".")[0]}] baseline: ${r.baselineCmd}`);
  console.log(`       agentmap: ${r.toolCmd}`);
}
console.log(`\nHEADLINE: ${pct(totBase, totTool)}% fewer tokens (${totBase} -> ${totTool}) across ${rows.length} scenarios.`);

// machine-readable footer for the RESULTS.md generator / CI
console.log("\n@@JSON@@" + JSON.stringify({
  repo: REPO, node: nodeV, fileCount, sha, totalBaseTok: totBase, totalToolTok: totTool,
  savedPct: pct(totBase, totTool),
  rows: rows.map((r) => ({ ...r, savedPct: pct(r.base, r.tool) })),
}));
