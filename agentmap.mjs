#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — the repo map your coding agent is *forced* to use.
//
//  A ts-morph code-relationship map for TypeScript/JavaScript repos. Unlike
//  one-shot "pack the repo into a prompt" tools, this is a QUERYABLE, RANKED
//  map: PageRank importance (approach from Aider's repo map), Aider-style
//  symbol ranking, a token-budgeted `--map` digest, and a single `--any`
//  router (file → symbol → feature → live git-grep) — wired into the agent
//  loop via a post-commit auto-refresh + a PreToolUse hook.
//
//  Near-zero deps (ts-morph only). Runs in the target repo's cwd.
//  Algorithm credit: Aider's repo map (Apache-2.0) — github.com/Aider-AI/aider
// ============================================================================
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync, lstatSync, chmodSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// Lazy ts-morph: its ~105ms module init only fires on a COLD rebuild. Warm cache
// queries (the common case) never construct a Project, so they skip the load
// entirely (~2x faster warm). createRequire keeps it synchronous — no async to
// thread through build()/makeProject().
const _require = createRequire(import.meta.url);
let _tsm = null;
const tsMorph = () => (_tsm ??= _require("ts-morph"));

const MAP = ".claude/agentmap/map.json";
const MAP_LEGACY = ".claude/agentmap.json"; // pre-namespacing path; read for migration
// Bumped 2 → 3: Vue SFC support. `.vue` files now appear in the map and the
// source-discovery / freshness checks treat them as first-class source files.
// Old caches (schema 2) are ignored so the first run after upgrade rebuilds.
const SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Tuning constants — KEEP THESE VALUES IDENTICAL (output + marketing must not
// shift). Hoisted out of inline literals so the algorithm is self-documenting.
// ---------------------------------------------------------------------------
const DAMPING = 0.85;            // PageRank damping (Aider parity)
const TOL = 1e-6;                // power-iteration convergence tolerance
const MAX_ITER = 100;            // power-iteration iteration cap
const IDENT_BOOST = 10;          // weight ×: mentioned ident, or long multi-word ident
const RARE_PENALTY = 0.1;        // weight ×: ident defined in >RARE_DEFINERS files (too common)
const UNDERSCORE_PENALTY = 0.1;  // weight ×: private-ish `_`-prefixed ident
const MIN_IDENT_LEN = 8;         // min length for the long-multi-word ident boost
const RARE_DEFINERS = 5;         // >this many definers ⇒ ident is too common ⇒ penalize
const FOCUS_BOOST = 50;          // ref-edge weight × when refFile is in the focus set
const DEFAULT_BUDGET = 8192;     // --map token budget with no --focus
const FOCUS_BUDGET = 1024;       // --map token budget when --focus is given
const HUBS_LIMIT = 15;           // # of hubs persisted/printed
const RANKED_SYMBOLS_LIMIT = 80; // # of ranked symbols persisted
const CONTENT_LINES_LIMIT = 40;  // # of git-grep lines shown in the --any content fallback
const RELATED_LIMIT = 10;        // # of related files shown by --relates
const SYMS_PER_FILE = 8;         // per-file symbol cap in the --map digest
const DEFAULT_SYMBOLS = 30;      // default count for --symbols with no n
const MAXBUF = 64 * 1024 * 1024; // child_process maxBuffer — avoid ENOBUFS on big git output

const sh = (c) => { try { return execSync(c, { stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAXBUF }).toString().trim(); } catch { return ""; } };

// Live content search for the --any fallback. `git grep` over tracked +
// untracked files (skips gitignored paths like node_modules). Reads DISK, so
// never stale. -F = fixed-string so literals like "bg-[#faf8f2]" aren't regex.
// stderr ignored so "fatal: not a git repository" stays quiet in non-git repos.
// Exclude sensitive files from the --untracked sweep so a local .env / key /
// secrets file never gets scanned and surfaced (and via MCP fed to an LLM).
// Mix of path globs (env/key/cert/SSH-key shapes) and case-insensitive name
// matches (anything *secret* / *credential* / *.password*). These are pathspecs,
// not regexes — git applies them as exclusions to the search tree.
const SENSITIVE_EXCLUDES = [
  ":!.env", ":!.env.*", ":!**/.env", ":!**/.env.*",
  // also any *.env (e.g. prod.env, .env.local already covered above) at any depth
  ":!*.env", ":!**/*.env",
  ":!*.pem", ":!*.key", ":!*.p12", ":!*.pfx", ":!*.crt", ":!id_rsa*",
  ":(exclude,icase)*secret*", ":(exclude,icase)*credential*", ":(exclude,icase)*.password*",
];
const contentSearch = (q) => {
  try {
    return execFileSync("git", ["grep", "-F", "--untracked", "-n", "-i", "-I", "-e", q, "--", ".", ":!.claude/agentmap/", ...SENSITIVE_EXCLUDES], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAXBUF }).trim();
  } catch { return ""; }
};
const currentSha = () => sh("git rev-parse --short HEAD");
const dirtyCount = () =>
  // --untracked-files=all so a new file inside a brand-new untracked DIR is
  // listed individually (default "all" folds it to "?? newdir/" and the
  // extension regex misses it → a STALE cache would be served).
  sh("git status --porcelain --untracked-files=all").split("\n").filter(Boolean).filter((l) => {
    let p = l.slice(3);                                  // strip "XY " status prefix
    if (p.includes(" -> ")) p = p.split(" -> ").pop();   // rename: keep the new path
    p = p.replace(/^"|"$/g, "");                         // unquote space/special paths
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/.test(p);
  }).length;
const tokEst = (s) => Math.ceil((s || "").length / 4); // rough chars/4 estimate

// get-or-init a Map value (readable replacement for the dense `m.get(k) ?? m.set(...)` idiom).
const getOrSet = (m, k, make) => { let v = m.get(k); if (v === undefined) { v = make(); m.set(k, v); } return v; };

// Best-effort source fingerprint for NON-git repos (sha == ""). Hash of sorted
// "path:mtimeMs:size" for source files so the cache can be trusted between runs
// without a full reparse. Skips node_modules/.git/.next. Any error ⇒ "" (caller
// falls through to build, i.e. current behavior). Never used on the git path.
// Includes `.vue` so editing a Vue SFC invalidates the non-git cache too.
const SRC_EXT = /\.(ts|tsx|mts|cts|jsx|js|mjs|cjs|vue)$/;
function sourceFingerprint() {
  try {
    const entries = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".git" || name === ".next") continue;
        const full = dir + "/" + name;
        let st;
        // lstatSync (NOT statSync) so a symlink reports as a symlink instead of
        // its target. Symlinked entries are SKIPPED entirely — never recursed
        // into, never stat'd through — so a circular symlink can't cause infinite
        // recursion / stack overflow.
        try { st = lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(full);
        else if (SRC_EXT.test(name)) entries.push(`${full}:${st.mtimeMs}:${st.size}`);
      }
    };
    walk(".");
    entries.sort();
    return createHash("sha1").update(entries.join("\n")).digest("hex");
  } catch { return ""; }
}

// =============================================================================
// Vue Single File Component support — best-effort, zero-dependency.
//
// agentmap is TS/JS-first. Vue `.vue` SFCs are NOT TypeScript; the Vue compiler
// (`@vue/compiler-sfc`) is intentionally NOT a dependency (CONTRIBUTING near-
// zero-deps rule). Instead we extract ONLY the `<script>` / `<script setup>`
// block text with a conservative regex and feed it to ts-morph as a VIRTUAL
// source file (e.g. `App.vue.ts`). A virtual→real path map (see build())
// rewrites every user-facing path back to the real `.vue` path so no
// `.vue.ts` / `.vue.js` ever leaks into JSON or prose.
//
// Non-goals: no template AST, no `<style>` parsing, no Nuxt auto-import
// resolution, no Svelte/Astro. Only `<script>` blocks that look like JS/TS.
// =============================================================================

// Find the first top-level `<script ...>` block (optionally `<script setup ...>`)
// whose opening tag does NOT carry `src="..."` (external script reference —
// the actual JS lives in another file agentmap already indexes on its own).
// Handles single + double quoted lang/src attributes and `lang="ts"`/`ts`.
// Returns { lang, setup, text } for the matched block, or null if none.
//
// Greedy-free: stops at the FIRST `</script>` on its own. Vue forbids nested
// `<script>` tags, so a non-greedy match up to `</script>` is safe. We do NOT
// support `<script>` + `<script setup>` in the same SFC for indexing — we pick
// the richer one: prefer `setup` block if present, else the normal block.
function extractVueScripts(text) {
  const blocks = [];
  // Open-tag matcher is QUOTE-AWARE: attribute values may legitimately contain
  // `>` (e.g. `<script setup lang="ts" generic="T extends Record<string, unknown>">`
  // — a common Vue 3 idiom for typed generic components). We require all
  // attributes to be either bare (`setup`) or quoted (`name="value"` or
  // `name='value'`), which matches valid SFC syntax. Bareword and unquoted forms
  // are intentionally not matched because they're not valid HTML and would
  // almost certainly indicate a parsing bug we want to surface, not silently
  // misparse.
  const re = /<script(\s+[a-zA-Z][\w-]*(\s*=\s*(?:"[^"]*"|'[^']*'))?)*\s*\/?>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const attrs = (m[0].slice(7, -1) || "").trim(); // strip <script…> wrapper
    // find body: text after the opening tag up to </script>
    const openEnd = m.index + m[0].length;
    const closeStart = text.toLowerCase().indexOf("</script>", openEnd);
    if (closeStart === -1) break; // unterminated — stop scanning
    const body = text.slice(openEnd, closeStart);
    // external script reference → skip (the target file is indexed directly).
    if (/\bsrc\s*=\s*["'][^"']+["']/i.test(attrs)) continue;
    if (!body.trim()) continue; // empty body (e.g. <script/>) — not useful
    const setup = /\bsetup\b/i.test(attrs);
    const lang = (attrs.match(/\blang\s*=\s*["']([^"']+)["']/i) || [])[1] || "js";
    blocks.push({ lang: lang.toLowerCase(), setup, text: body });
    re.lastIndex = closeStart + "</script>".length; // resume after </script>
  }
  if (!blocks.length) return null;
  // Prefer a setup block (the modern idiom) when present; else the plain block.
  return blocks.find((b) => b.setup) || blocks[0];
}

// Virtual file path mapping for a `.vue` source. The virtual path is what
// ts-morph sees (so `.ts`/`.js` parsing kicks in); the real path is what every
// user-facing output shows. `lang="ts"` → `.vue.ts`, otherwise `.vue.js`.
function vueVirtualPath(realPath, lang) {
  return lang === "ts" ? `${realPath}.ts` : `${realPath}.js`;
}

// Feature = first real route segment under app/ (or src/app/), skipping route
// groups (parens), dynamic segments ([id]) and parallel routes (@slot).
function featureOf(path) {
  const m = path.match(/(?:^|.*\/)(?:src\/)?app\/(.+)/);
  if (!m) return null;
  for (const p of m[1].split("/").slice(0, -1)) {
    if (p.startsWith("(") || p.startsWith("[") || p.startsWith("@")) continue;
    return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Personalized PageRank — dependency-free power iteration. Deterministic
// (stable node order, no PRNG). Edges = [{from, to, weight}]. Rank flows
// from→to, so with importer→imported edges, heavily-imported hubs rank high.
// Dangling-node mass + teleport both go to the personalization vector
// (matches Aider's `dangling=personalization`). Returns { node: score }.
// ---------------------------------------------------------------------------
function pagerank(nodes, edges, { personalization = null, damping = DAMPING, tol = TOL, maxIter = MAX_ITER } = {}) {
  const N = nodes.length;
  if (N === 0) return {};
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const outW = new Float64Array(N);
  const adj = Array.from({ length: N }, () => []);
  for (const e of edges) {
    const a = idx.get(e.from), b = idx.get(e.to);
    if (a === undefined || b === undefined || a === b) continue; // skip self-loops
    const w = e.weight > 0 ? e.weight : 1;
    adj[a].push([b, w]); outW[a] += w;
  }
  // teleport vector p (normalized personalization, or uniform)
  const p = new Float64Array(N);
  if (personalization) {
    let s = 0;
    for (const [k, v] of Object.entries(personalization)) {
      const i = idx.get(k);
      if (i !== undefined && v > 0) { p[i] = v; s += v; }
    }
    if (s === 0) p.fill(1 / N); else for (let i = 0; i < N; i++) p[i] /= s;
  } else p.fill(1 / N);
  let r = Float64Array.from(p);
  for (let iter = 0; iter < maxIter; iter++) {
    let dangling = 0;
    for (let i = 0; i < N; i++) if (outW[i] === 0) dangling += r[i];
    const next = new Float64Array(N);
    for (let i = 0; i < N; i++) next[i] = (1 - damping) * p[i] + damping * dangling * p[i];
    for (let i = 0; i < N; i++) {
      if (outW[i] === 0) continue;
      const ri = damping * r[i];
      for (const [j, w] of adj[i]) next[j] += ri * (w / outW[i]);
    }
    let diff = 0;
    for (let i = 0; i < N; i++) diff += Math.abs(next[i] - r[i]);
    r = next;
    if (diff < tol) break;
  }
  const out = {};
  for (let i = 0; i < N; i++) out[nodes[i]] = r[i];
  return out;
}

// Aider-style identifier edge-weight multipliers. `mentioned` = focus/query
// idents (boosted). Rarity is approximated by the >5-definers penalty.
function identMul(ident, defineCount, mentioned) {
  let mul = 1.0;
  const hasAlpha = /[a-zA-Z]/.test(ident);
  const isSnake = ident.includes("_") && hasAlpha;
  const isKebab = ident.includes("-") && hasAlpha;
  const isCamel = /[a-z]/.test(ident) && /[A-Z]/.test(ident);
  if (mentioned && mentioned.has(ident)) mul *= IDENT_BOOST;
  if ((isSnake || isKebab || isCamel) && ident.length >= MIN_IDENT_LEN) mul *= IDENT_BOOST;
  if (ident.startsWith("_")) mul *= UNDERSCORE_PENALTY;
  if (defineCount > RARE_DEFINERS) mul *= RARE_PENALTY;
  return mul;
}

// Construct a ts-morph Project robustly: use tsconfig.json when present + valid;
// else (missing / malformed / solution-style references that index 0 files) fall
// back to broad source globs so the tool degrades gracefully instead of crashing.
function makeProject() {
  const { Project } = tsMorph();
  // skipFileDependencyResolution: ~40% faster build, verified identical edge
  // set (we resolve module specifiers explicitly below, never via the implicit
  // dependency graph). allowJs so .js/.jsx are parsed.
  const FAST = { skipFileDependencyResolution: true };
  // Read tsconfig/jsconfig baseUrl+paths defensively so "@/…"/"~/…" alias
  // imports still resolve when tsconfig is absent/broken. Any failure ⇒ none.
  const aliasOpts = (() => {
    for (const cfg of ["tsconfig.json", "jsconfig.json"]) {
      try {
        if (!existsSync(cfg)) continue;
        const co = (JSON.parse(readFileSync(cfg, "utf8")) || {}).compilerOptions || {};
        const out = {};
        if (co.baseUrl) out.baseUrl = co.baseUrl;
        if (co.paths) out.paths = co.paths;
        if (Object.keys(out).length) return out;
      } catch { /* ignore — proceed without paths */ }
    }
    return {};
  })();

  let project;
  if (existsSync("tsconfig.json")) {
    try { project = new Project({ tsConfigFilePath: "tsconfig.json", ...FAST }); }
    catch {
      // tsconfig present but unreadable/malformed — don't silently degrade.
      console.error("# warning: tsconfig.json unreadable, using source globs");
      project = new Project({ compilerOptions: { allowJs: true, ...aliasOpts }, ...FAST });
    }
  } else {
    project = new Project({ compilerOptions: { allowJs: true, ...aliasOpts }, ...FAST });
  }
  // tsconfig `include` usually omits build/pipeline scripts — add by path.
  project.addSourceFilesAtPaths([
    "scripts/**/*.{mjs,cjs,js}", "*.mjs", "*.cjs",
  ]);
  // Catch source files a narrow tsconfig `include` misses (monorepo / subdir-
  // scoped) WITHOUT an expensive full-tree FS glob (which cost ~600ms to find a
  // handful of files). Enumerate cheaply via `git ls-files` (tracked + untracked-
  // not-ignored — node_modules etc. excluded by --exclude-standard) and add only
  // files not already loaded. Non-git repos fall back to the broad globs.
  const loaded = new Set(project.getSourceFiles().map((s) => s.getFilePath()));
  const cwdp = process.cwd().replace(/\\/g, "/");
  const listed = sh("git ls-files --cached --others --exclude-standard").split("\n").filter(Boolean);
  // `.vue` discovery: same channel as TS/JS (git ls-files when available, else
  // a broad glob fallback). We do NOT hand `.vue` straight to ts-morph (it is
  // not TS/JS). Instead, for each `.vue` file we read its `<script>` block via
  // extractVueScripts() and register it as a VIRTUAL source file
  // (`App.vue.ts` / `App.vue.js`). A virtual→real path map is returned alongside
  // the project so build() can rewrite every user-facing path back to `.vue`.
  const vueFiles = [];
  if (listed.length) {
    const missing = [];
    for (const f of listed) {
      if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f)) {
        const segs = f.split("/");
        if (segs.includes("node_modules") || segs.includes(".next")) continue;
        if (!loaded.has(`${cwdp}/${f}`)) missing.push(f);
      } else if (f.endsWith(".vue")) {
        const segs = f.split("/");
        if (segs.includes("node_modules") || segs.includes(".next")) continue;
        vueFiles.push(f);
      }
    }
    if (missing.length) project.addSourceFilesAtPaths(missing);
  } else {
    // non-git fallback: broad globs (mts/cts/mjs/cjs per base dir included).
    project.addSourceFilesAtPaths([
      "src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "app/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "components/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "lib/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "pages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    ]);
    // Non-git `.vue` fallback: walk the tree like sourceFingerprint() does.
    try {
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          if (name === "node_modules" || name === ".git" || name === ".next") continue;
          const full = dir + "/" + name;
          // lstatSync (NOT statSync) + skip symlinks, matching sourceFingerprint():
          // a circular symlink would otherwise recurse until the stack overflows.
          let st; try { st = lstatSync(full); } catch { continue; }
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) walk(full);
          else if (name.endsWith(".vue")) vueFiles.push(full.replace(/^\.\//, ""));
        }
      };
      walk(".");
    } catch { /* ignore — proceed without Vue */ }
  }
  // Build the virtual→real map and register each `<script>` block as a virtual
  // ts-morph source. Files without a usable `<script>` block are silently
  // skipped (template/style-only SFCs contribute nothing to the import graph).
  const vueMap = Object.create(null); // virtualPath → realPath
  const vueReal = Object.create(null); // realPath → true (for resolver)
  for (const f of vueFiles) {
    let text; try { text = readFileSync(f, "utf8"); } catch { continue; }
    const block = extractVueScripts(text);
    if (!block || !block.text.trim()) continue;
    const vpath = vueVirtualPath(f, block.lang);
    project.createSourceFile(`${cwdp}/${vpath}`, block.text, { overwrite: true });
    vueMap[`${cwdp}/${vpath}`] = `${cwdp}/${f}`;
    vueReal[`${cwdp}/${f}`] = true;
  }
  return { project, vueMap, vueReal };
}

// ---------------------------------------------------------------------------
// build() — parse the repo, extract file imports/exports (+ which named
// symbols cross each edge), compute file PageRank, run the Aider-style
// identifier graph to rank individual symbols, and persist agentmap.json.
// ---------------------------------------------------------------------------
function build() {
  const t0 = Date.now();
  const { project, vueMap, vueReal } = makeProject();
  const { SyntaxKind } = tsMorph();
  const CallExpression = SyntaxKind.CallExpression;
  const cwd = process.cwd().replace(/\\/g, "/");
  // rel() rewrites ts-morph file paths to repo-relative keys. For Vue virtual
  // sources (`App.vue.ts`), vueMap rewrites back to the real `.vue` path so
  // users never see virtual paths in the map, hubs, --relates, or --find.
  const rel = (p) => {
    const abs = p.replace(/\\/g, "/");
    const real = vueMap[abs];
    return (real || abs).replace(cwd + "/", "");
  };
  const files = {}, dependents = {}, features = {};
  // PATH-SEGMENT exclusion (not substring) so e.g. components/.next-demo or
  // src/node_modules_helper.ts are NOT wrongly excluded.
  const excluded = (p) => { const segs = p.split("/"); return segs.includes("node_modules") || segs.includes(".next"); };

  // Resolve a relative module specifier (from the importing file's dir) to an
  // in-project source file key. Tries the bare path, then each extension, then
  // /index.*. Returns the rel key or null. Powers side-effect (6b) + dynamic
  // import()/require() (6c) edges that ts-morph's specifier resolution skips.
  const RES_EXT = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
  const resolveSpec = (fromAbsDir, spec) => {
    if (!spec.startsWith(".")) return null; // only relative, in-project specifiers
    // normalize fromAbsDir + spec into an absolute-ish posix path
    const join = (a, b) => {
      const parts = (a + "/" + b).split("/"); const st = [];
      for (const seg of parts) { if (seg === "" || seg === ".") continue; if (seg === "..") st.pop(); else st.push(seg); }
      return (a.startsWith("/") ? "/" : "") + st.join("/");
    };
    const baseAbs = join(fromAbsDir, spec);
    const tryGet = (abs) => { const sf = project.getSourceFile(abs); return sf ? sf : null; };
    // Vue SFC: `import X from "./C.vue"` (exact) ALWAYS wins — the user wrote
    // `.vue` explicitly, so we honor that. This check must stay BEFORE the
    // TS/JS loop.
    if (vueReal[baseAbs]) return rel(baseAbs);
    let sf = tryGet(baseAbs);
    if (!sf) for (const e of RES_EXT) { sf = tryGet(`${baseAbs}.${e}`); if (sf) break; }
    if (!sf) for (const e of RES_EXT) { sf = tryGet(`${baseAbs}/index.${e}`); if (sf) break; }
    // TS/JS SHADOW WINS: when a same-name .ts/.js exists, the extensionless
    // `import "./C"` resolves to it (TS/JS-first priority is preserved). Only
    // fall through to `.vue` as a last resort, when no TS/JS shadow exists.
    if (sf) return rel(sf.getFilePath());
    if (vueReal[`${baseAbs}.vue`]) return rel(`${baseAbs}.vue`);
    return null;
  };

  const sourceFiles = project.getSourceFiles();
  process.stderr.write(`# agentmap: parsing ${sourceFiles.length} source files…\n`);
  for (const sf of sourceFiles) {
    const path = rel(sf.getFilePath());
    if (excluded(path)) continue;
    const fromDir = sf.getDirectoryPath().replace(/\\/g, "/");
    // exports, remembering which exported name was the file's DEFAULT export so
    // default-import edges can later resolve "default" → the real symbol name.
    let defaultExportName = null;
    const exports = [...sf.getExportedDeclarations()].map(([name, d]) => {
      const resolved = name === "default" ? (d[0]?.getName?.() ?? "default") : name;
      if (name === "default") defaultExportName = resolved;
      return { name: resolved, kind: d[0]?.getKindName?.() ?? "?" };
    });
    // Dependency edges from static imports + re-export barrels, with the set
    // of named symbols crossing each edge (used for edge weights + the ident
    // graph). importedSymbols[targetPath] = [names...].
    const importedSymbols = {};
    const addEdge = (tp, names) => {
      if (!tp || excluded(tp)) return;
      (importedSymbols[tp] ??= []).push(...names);
    };
    for (const imp of sf.getImportDeclarations()) {
      if (imp.isTypeOnly()) continue; // type-only modules must not inflate runtime PageRank
      const t = imp.getModuleSpecifierSourceFile();
      if (t) {
        // skip individual type-only named specifiers (`import { type X }`)
        const names = imp.getNamedImports().filter((n) => !n.isTypeOnly()).map((n) => n.getName());
        if (imp.getDefaultImport()) names.push("default"); // resolved to the real name in a post-pass below
        if (imp.getNamespaceImport()) names.push("*");
        addEdge(rel(t.getFilePath()), names.length ? names : ["*"]);
      } else {
        // 6b: side-effect import (`import "./x"`) — no source file via ts-morph,
        // but a relative specifier resolving in-project still counts as an edge.
        const spec = imp.getModuleSpecifierValue();
        const tp = resolveSpec(fromDir, spec);
        if (tp) addEdge(tp, ["*"]);
      }
    }
    for (const exp of sf.getExportDeclarations()) {
      if (exp.isTypeOnly()) continue; // type-only re-exports excluded from edges
      const t = exp.getModuleSpecifierSourceFile();
      if (t) addEdge(rel(t.getFilePath()), exp.getNamedExports().filter((n) => !n.isTypeOnly()).map((n) => n.getName()));
    }
    // 6c: dynamic import("./x") and require("./x") with relative, in-project
    // string-literal specifiers → edge with names ["*"]. Prefilter on raw text
    // so we only AST-walk the few files that actually contain a dynamic call.
    const srcText = sf.getFullText();
    if (srcText.includes("import(") || srcText.includes("require(")) for (const call of sf.getDescendantsOfKind(CallExpression)) {
      const expr = call.getExpression();
      const kind = expr.getKind();
      const isImport = kind === SyntaxKind.ImportKeyword;
      const isRequire = expr.getText?.() === "require";
      if (!isImport && !isRequire) continue;
      const a0 = call.getArguments()[0];
      if (!a0 || a0.getKind() !== SyntaxKind.StringLiteral) continue;
      const tp = resolveSpec(fromDir, a0.getLiteralText());
      if (tp) addEdge(tp, ["*"]);
    }
    const imports = Object.keys(importedSymbols);
    for (const tp of imports) (dependents[tp] ??= []).push(path);
    files[path] = { exports, imports, importedSymbols, defaultExportName };
    const feat = featureOf(path);
    if (feat) (features[feat] ??= []).push(path);
  }
  // 7: resolve default-import edges. A default import was recorded literally as
  // "default"; rankSymbols skips "default", so default-exported symbols (the
  // dominant Next.js component) never ranked. Map each "default" entry to the
  // TARGET file's resolved default-export name so it forms reference edges.
  for (const f of Object.values(files)) {
    for (const tp of Object.keys(f.importedSymbols)) {
      const dn = files[tp]?.defaultExportName;
      if (!dn || dn === "default") continue;
      f.importedSymbols[tp] = f.importedSymbols[tp].map((n) => (n === "default" ? dn : n));
    }
  }
  for (const p in files) files[p].dependents = dependents[p] ?? [];

  // --- File PageRank: edges importer→imported, weighted by # symbols crossed.
  const nodes = Object.keys(files);
  const fileEdges = [];
  for (const [p, f] of Object.entries(files))
    for (const tp of f.imports)
      if (files[tp]) fileEdges.push({ from: p, to: tp, weight: (f.importedSymbols[tp] || []).length || 1 });
  const fileRank = pagerank(nodes, fileEdges);
  for (const p of nodes) files[p].pagerank = +(fileRank[p] || 0).toFixed(6);

  // --- Symbol ranking (Aider-style): identifier graph from named imports.
  const rankedSymbols = rankSymbols(files, null);

  // hubs: now PageRank-ranked (raw dependent count shown alongside).
  const hubs = nodes
    .map((p) => [p, files[p].pagerank, files[p].dependents.length])
    .sort((a, b) => b[1] - a[1])
    .slice(0, HUBS_LIMIT)
    .map(([p, pr, deg]) => `${p} (deg ${deg}, pr ${pr})`);

  // defaultExportName was only needed for the fix-#7 post-pass — drop it before
  // persisting so the on-disk `files` shape stays stable.
  for (const p of nodes) delete files[p].defaultExportName;

  const sha = currentSha();
  const out = {
    schema: SCHEMA_VERSION, generatedSha: sha, dirty: dirtyCount(), fileCount: nodes.length,
    // fingerprint lets non-git repos (sha === "") trust the cache across runs.
    fingerprint: sha ? undefined : sourceFingerprint(),
    hubs, features, rankedSymbols: rankedSymbols.slice(0, RANKED_SYMBOLS_LIMIT), files,
  };
  mkdirSync(".claude/agentmap", { recursive: true });
  // Atomic write: tmp + rename so a concurrent background rebuild can never
  // expose a torn/truncated map.json to a reader.
  const tmp = MAP + ".tmp";
  writeFileSync(tmp, JSON.stringify(out));
  renameSync(tmp, MAP);
  process.stderr.write(`# agentmap: built ${nodes.length} files in ${Date.now() - t0}ms\n`);
  return out;
}

// Build the Aider-style identifier graph from the file map and return a
// ranked list of { file, name, kind, rank }. `focus` (Set of paths) +
// derived mentioned idents personalize the ranking when given.
function rankSymbols(files, focus) {
  const defines = new Map();      // ident -> Set(file)
  const references = new Map();   // ident -> [file...] (multiplicity)
  const definition = new Map();   // `${file}|${ident}` -> {file, name, kind}
  for (const [p, f] of Object.entries(files)) {
    for (const e of f.exports) {
      getOrSet(defines, e.name, () => new Set()).add(p);
      definition.set(`${p}|${e.name}`, { file: p, name: e.name, kind: e.kind });
    }
  }
  for (const [p, f] of Object.entries(files))
    for (const tp of f.imports)
      for (const name of f.importedSymbols[tp] || [])
        if (name !== "*" && name !== "default") getOrSet(references, name, () => []).push(p);

  // mentioned idents from focus files' exports + their basenames
  let mentioned = null;
  if (focus && focus.size) {
    mentioned = new Set();
    for (const p of focus) {
      for (const e of (files[p]?.exports || [])) mentioned.add(e.name);
      const base = p.split("/").pop().replace(/\.[^.]+$/, "");
      mentioned.add(base);
    }
  }

  const nodes = Object.keys(files);
  const edges = [];
  for (const ident of defines.keys()) {
    if (!references.has(ident)) continue;
    const mul = identMul(ident, defines.get(ident).size, mentioned);
    const counts = new Map();
    for (const refFile of references.get(ident)) counts.set(refFile, (counts.get(refFile) || 0) + 1);
    for (const [refFile, n] of counts)
      for (const defFile of defines.get(ident)) {
        if (refFile === defFile) continue;
        let useMul = mul;
        if (focus && focus.has(refFile)) useMul *= FOCUS_BOOST;
        edges.push({ from: refFile, to: defFile, weight: useMul * Math.sqrt(n), ident });
      }
  }
  // personalization seeds: focus files + files whose name matches a mention
  let pers = null;
  if (focus && focus.size) {
    pers = {};
    const unit = 100 / nodes.length;
    for (const p of nodes) {
      let v = 0;
      if (focus.has(p)) v += unit;
      const parts = new Set([...p.split("/"), p.split("/").pop(), p.split("/").pop().replace(/\.[^.]+$/, "")]);
      if (mentioned && [...parts].some((x) => mentioned.has(x))) v += unit;
      if (v > 0) pers[p] = v;
    }
    if (!Object.keys(pers).length) pers = null;
  }
  const rank = pagerank(nodes, edges, pers ? { personalization: pers } : {});

  // redistribute each file's rank across its out-edges onto (defFile, ident)
  const out = new Map();      // `${file}|${ident}` -> total weight
  const totalW = new Map();
  for (const e of edges) totalW.set(e.from, (totalW.get(e.from) || 0) + e.weight);
  for (const e of edges) {
    const share = (rank[e.from] || 0) * e.weight / (totalW.get(e.from) || 1);
    const k = `${e.to}|${e.ident}`;
    out.set(k, (out.get(k) || 0) + share);
  }
  const ranked = [...out.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, r]) => ({ ...(definition.get(k) || { file: k.slice(0, k.lastIndexOf("|")), name: k.slice(k.lastIndexOf("|") + 1), kind: "?" }), rank: +r.toFixed(6) }))
    .filter((d) => !(focus && focus.has(d.file)));

  // Aider parity (#8): keep exported symbols that NOTHING imports (Aider gives
  // them a 0.1 self-edge; pagerank() skips self-loops, so we append them here
  // with a tiny baseline rank below the lowest real rank). Lets public-API
  // entry points + default-export components surface in the digest tail.
  const present = new Set(ranked.map((d) => `${d.file}|${d.name}`));
  const lowest = ranked.length ? ranked[ranked.length - 1].rank : 0;
  const baseline = +(lowest - 1e-6 > 0 ? lowest - 1e-6 : 1e-6).toFixed(6);
  const tail = [];
  for (const def of definition.values()) {
    const k = `${def.file}|${def.name}`;
    if (present.has(k)) continue;
    if (focus && focus.has(def.file)) continue;
    tail.push({ ...def, rank: baseline });
  }
  tail.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...ranked, ...tail];
}

// Serve the cached map only when provably current: same HEAD, known schema,
// clean tree. A dirty tree REBUILDS from disk so queries reflect in-flight edits.
function ensureFresh() {
  const sha = currentSha();
  // Read the namespaced path; fall back to the legacy '.claude/agentmap.json'
  // when the new path is missing (migration from a pre-namespacing install — the
  // legacy file is still trustworthy, the next build() rewrites to the new path).
  const mapPath = existsSync(MAP) ? MAP : (existsSync(MAP_LEGACY) ? MAP_LEGACY : MAP);
  if (existsSync(mapPath)) {
    try {
      const cached = JSON.parse(readFileSync(mapPath, "utf8"));
      // Trust cache only if: same HEAD, known schema, it was built CLEAN
      // (cached.dirty === 0 — never trust a map built mid-edit, even after a
      // revert returns the tree to clean), AND the tree is clean right now.
      if (sha && cached.generatedSha === sha && cached.schema === SCHEMA_VERSION && cached.dirty === 0 && dirtyCount() === 0) return cached;
      // NON-git repo (sha === ""): no HEAD to compare. Trust the cache when a
      // lightweight source fingerprint (path:mtime:size hash) is unchanged so
      // we don't full-reparse on every call. Best-effort — any mismatch/error
      // falls through to build(). Does NOT touch the git-repo path above.
      if (!sha && cached.schema === SCHEMA_VERSION && cached.fingerprint) {
        const fp = sourceFingerprint();
        if (fp && cached.fingerprint === fp) return cached;
      }
    } catch {}
  }
  return build();
}

// Resolve a query to a file key, in PREFERENCE order so a loose substring path
// match never shadows a symbol the user actually wanted:
//   (a) exact path key
//   (b) unique basename match, CASE-INSENSITIVE
//   (c) unique case-insensitive SUBSTRING match (weakest — only when a/b miss)
//   (d) multiple substring matches → {key:null, candidates} for disambiguation
function resolveFile(keys, filesObj, q) {
  if (filesObj[q]) return { key: q };                                              // (a)
  const ql = q.toLowerCase();
  const base = keys.filter((k) => k.split("/").pop().toLowerCase() === ql);        // (b) case-insensitive basename
  if (base.length === 1) return { key: base[0] };
  const subs = keys.filter((k) => k.toLowerCase().includes(ql));                   // (c)/(d) substring
  if (subs.length === 1) return { key: subs[0] };
  return { key: null, candidates: subs };
}

function fileBlock(key, f) {
  console.log(`exports (${f.exports.length}): ${f.exports.map((e) => `${e.name}(${e.kind})`).join(", ") || "—"}`);
  console.log(`imports (${f.imports.length}): ${f.imports.join(", ") || "—"}`);
  console.log(`dependents (${f.dependents.length}): ${f.dependents.join(", ") || "—"}`);
}

// Strip // line comments and /* */ block comments from a JSONC string WITHOUT
// touching comment-like sequences inside double-quoted strings (so a value like
// "https://x" or "a /* b */ c" is preserved verbatim). Single-pass state machine:
// tracks whether we're inside a string (and an escape inside it) vs a line/block
// comment. Trailing commas are NOT handled — only comments, which is what real-
// world settings.json files carry.
function stripJsonComments(src) {
  let out = "";
  let inStr = false, esc = false, inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

// Parse a settings.json that may be JSONC: try strict JSON first, then retry
// after stripping comments, and only then surface the caller's clear error.
function parseSettings(text, settingsPath) {
  try { return JSON.parse(text) || {}; }
  catch {
    try { return JSON.parse(stripJsonComments(text)) || {}; }
    catch { throw new Error(`${settingsPath} is not valid JSON — fix or remove it, then re-run`); }
  }
}

// ---------------------------------------------------------------------------
// --install-hooks: copy the package post-commit hook into .git/hooks, copy the
// PreToolUse nudge into .claude/hooks/agentmap-nudge.mjs, ensure .claude/agentmap/
// is gitignored, and auto-wire the Claude Code PreToolUse(Grep|Bash) nudge into
// the project's .claude/settings.json so map enforcement is ON by default (no
// manual copy-paste). Merge-safe + idempotent. With { dryRun:true } it prints the
// files it WOULD touch and writes nothing. Throws on any failure so the caller
// can stderr+exit 1.
// ---------------------------------------------------------------------------
function installHooks({ dryRun = false } = {}) {
  const src = new URL("./hooks/post-commit", import.meta.url);
  // The package hooks/ dir must ship alongside agentmap.mjs.
  if (!existsSync(src)) throw new Error(`packaged hook not found at ${src.pathname} (is the hooks/ dir present?)`);
  // The PreToolUse nudge that gets COPIED into the project (see below). It must
  // ship alongside agentmap.mjs too.
  const nudgeSrc = new URL("./hooks/agentmap-nudge.mjs", import.meta.url);
  if (!existsSync(nudgeSrc)) throw new Error(`packaged nudge not found at ${nudgeSrc.pathname} (is the hooks/ dir present?)`);

  // Locate the git dir of the CURRENT repo (cwd), then copy in the hook.
  const gitDir = sh("git rev-parse --git-dir");
  if (!gitDir) throw new Error("not a git repository (cwd has no .git) — run inside the repo you want to wire up");
  const hooksDir = `${gitDir}/hooks`;
  const dest = `${hooksDir}/post-commit`;

  // The nudge is copied into the PROJECT (not referenced inside node_modules) so
  // the documented one-liner `npx @raymondchins/agentmap --install-hooks` works
  // even though npx never populates ./node_modules — the old path
  // node_modules/@raymondchins/agentmap/hooks/agentmap-nudge.mjs simply does not
  // exist after an npx install, so the hook silently never fired. The nudge is
  // self-contained (Node stdlib only, no relative package imports), so copying it
  // standalone is safe. CLAUDE_PROJECT_DIR is set by Claude Code at hook time, so
  // the wired command resolves the copied file regardless of cwd.
  const nudgeDestRel = ".claude/hooks/agentmap-nudge.mjs";
  const NUDGE_CMD = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/agentmap-nudge.mjs"`;

  // .gitignore line: ignore the namespaced map DIR (not the legacy single file).
  const IGNORE_LINE = ".claude/agentmap/";
  const settingsPath = ".claude/settings.json";

  // --- Determine what WOULD change (so --dry-run and the pre-write notice both
  // describe the real plan). ---
  let ignoredAlready = false;
  if (existsSync(".gitignore")) {
    ignoredAlready = readFileSync(".gitignore", "utf8").split(/\r?\n/).some((l) => l.trim() === IGNORE_LINE);
  }
  let settings = {};
  if (existsSync(settingsPath)) {
    settings = parseSettings(readFileSync(settingsPath, "utf8"), settingsPath);
  }
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  const hasGrep = settings.hooks.PreToolUse.some(
    (e) => e?.matcher === "Grep" && Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("agentmap-nudge")),
  );
  const hasBash = settings.hooks.PreToolUse.some(
    (e) => e?.matcher === "Bash" && Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("agentmap-nudge")),
  );
  const alreadyWired = hasGrep && hasBash;

  // The set of files this run touches — used by both the dry-run report and the
  // one-line pre-write notice in the normal path.
  const targets = [
    dest,                                              // .git/hooks/post-commit
    nudgeDestRel,                                      // .claude/hooks/agentmap-nudge.mjs
    ...(ignoredAlready ? [] : [".gitignore"]),         // only if the ignore line is missing
    ...(alreadyWired ? [] : [settingsPath]),           // only if not already wired
  ];

  if (dryRun) {
    console.log("--dry-run: would create/overwrite the following files (no changes written):");
    for (const t of targets) console.log(`  ${t}`);
    return;
  }

  // Normal path: announce the plan, then write.
  console.log(`agentmap --install-hooks: writing ${targets.length} file(s): ${targets.join(", ")}`);

  // 1) post-commit hook → .git/hooks
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(dest, readFileSync(src, "utf8"), { mode: 0o755 });
  chmodSync(dest, 0o755); // explicit: writeFileSync mode is masked by umask

  // 2) nudge → .claude/hooks/agentmap-nudge.mjs (idempotent overwrite-on-rerun)
  mkdirSync(".claude/hooks", { recursive: true });
  writeFileSync(nudgeDestRel, readFileSync(nudgeSrc, "utf8"));

  // 3) .gitignore: ignore the namespaced map dir (append/create).
  if (!ignoredAlready) {
    if (existsSync(".gitignore")) {
      const cur = readFileSync(".gitignore", "utf8");
      writeFileSync(".gitignore", cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + IGNORE_LINE + "\n");
    } else {
      writeFileSync(".gitignore", IGNORE_LINE + "\n");
    }
  }

  // 4) Auto-wire the PreToolUse(Grep|Bash) nudge into project settings. Merge-
  // safe + idempotent: preserves existing settings/hooks, never duplicates ours.
  if (!hasGrep) settings.hooks.PreToolUse.push({ matcher: "Grep", hooks: [{ type: "command", command: NUDGE_CMD }] });
  if (!hasBash) settings.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: NUDGE_CMD }] });
  if (!alreadyWired) {
    mkdirSync(".claude", { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  // Success report.
  console.log(`installed post-commit hook → ${dest}`);
  console.log(`installed PreToolUse nudge → ${nudgeDestRel}`);
  console.log(ignoredAlready ? `.gitignore already has ${IGNORE_LINE}` : `added ${IGNORE_LINE} to .gitignore`);
  console.log(alreadyWired
    ? `${settingsPath} already wires the PreToolUse(Grep|Bash) → agentmap nudge — left as-is`
    : `wired PreToolUse(Grep|Bash) → agentmap nudge into ${settingsPath} (map enforcement on by default)`);
  console.log("\nDone — the map auto-refreshes on commit, and greps are nudged to agentmap first.");
}

// ---------------------------------------------------------------------------
// --setup-mcp: register the agentmap MCP server in the global configs of
// MCP-capable IDEs that aren't Claude Code (which uses --install-hooks instead).
// Merge-safe + idempotent; with { dryRun:true } it prints the plan and writes
// nothing. Throws on the first malformed config so the caller can stderr+exit 1.
// ---------------------------------------------------------------------------
function setupMcp({ dryRun = false } = {}) {
  const mcpPath = fileURLToPath(new URL("./mcp.mjs", import.meta.url));

  // npx materializes the package under a `_npx` cache dir that gets garbage-
  // collected, so a config pointing at that path would rot. When invoked via npx,
  // pin to the published spec instead; otherwise reference the resolved file.
  const isNpx = mcpPath.includes("_npx");
  const command = isNpx ? "npx" : process.execPath;
  const args = isNpx ? ["-y", "@raymondchins/agentmap", "--mcp"] : [mcpPath];

  // Each target: a global config file + how to graft the agentmap entry into it.
  // Antigravity is written to BOTH paths on purpose — older builds read only the
  // IDE-specific ~/.gemini/antigravity path, newer unified builds read the shared
  // ~/.gemini/config path, so writing both is version-proof.
  const targets = [
    {
      label: "OpenCode",
      path: join(homedir(), ".config", "opencode", "opencode.json"),
      graft: (cfg) => { (cfg.mcp ??= {}).agentmap = { type: "stdio", command, args, enabled: true }; },
    },
    {
      label: "Antigravity IDE",
      path: join(homedir(), ".gemini", "antigravity", "mcp_config.json"),
      graft: (cfg) => { (cfg.mcpServers ??= {}).agentmap = { command, args }; },
    },
    {
      label: "Antigravity (shared)",
      path: join(homedir(), ".gemini", "config", "mcp_config.json"),
      graft: (cfg) => { (cfg.mcpServers ??= {}).agentmap = { command, args }; },
    },
  ];

  if (dryRun) console.log("--dry-run: would configure MCP server (no changes written):");

  for (const { label, path, graft } of targets) {
    // Reuse parseSettings so JSONC (comments) is tolerated and a malformed file
    // throws a clear error WITHOUT clobbering the original (we never write on the
    // failure path, so no .bak dance is needed).
    let cfg = {};
    if (existsSync(path)) cfg = parseSettings(readFileSync(path, "utf8"), path);
    graft(cfg);

    if (dryRun) {
      console.log(`  ${label}: would write to ${path}`);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
      console.log(`configured ${label} MCP server → ${path}`);
    }
  }
}


// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
// Return the value after flag `f`, but treat a missing value OR one that looks
// like another flag (starts with "--") as undefined so the missing-arg guards
// fire — e.g. `--any --foo` must NOT search for the literal "--foo".
const arg = (f) => { const i = args.indexOf(f); if (i < 0) return undefined; const v = args[i + 1]; return v === undefined || v.startsWith("--") ? undefined : v; };

// --json is a GLOBAL modifier: when present, the chosen command emits exactly
// ONE JSON object to stdout (no prose). Branches build a result, then either
// console.log(JSON.stringify(obj)) or fall through to the prose printer. Exit
// codes are identical in both modes.
const wantJson = has("--json");
const out = (obj, prose) => { if (wantJson) console.log(JSON.stringify(obj)); else prose(); };

// Every recognized flag (the global modifiers + maintenance flags + each
// command + sub-flags that take a value). Anything starting with "-" that is
// NOT in this set is an unknown flag → usage error (exit 2), not a silent build.
const KNOWN = new Set([
  "--json", "--print",
  "--help", "-h", "--version", "-v", "--install-hooks", "--dry-run", "--setup-mcp", "--mcp",
  "--any", "--find", "--relates", "--map", "--focus", "--tokens",
  "--symbols", "--feature", "--features", "--hubs",
]);

// A token consumed as the VALUE of a value-taking flag is never itself a flag —
// so a dash-leading query like `--any "-O/bin/sh"` is bound as the query, not
// mistaken for an unknown flag. (arg() already rejects a "--"-leading value, so
// `--any --foo` still falls through to the missing-arg guard instead.)
const VALUE_FLAGS = new Set(["--any", "--find", "--relates", "--feature", "--focus", "--tokens", "--symbols"]);
const valueIdx = new Set();
for (let i = 0; i < args.length - 1; i++) if (VALUE_FLAGS.has(args[i])) valueIdx.add(i + 1);

const USAGE = `agentmap — the queryable, ranked repo map your coding agent is forced to use.

Usage: agentmap [command] [--json]

Query commands:
  --any <q>            route a query: file → symbol → feature → live git-grep
  --find <sym>         find exported symbols by (sub)name
  --relates <path>     a file's exports/imports/dependents + related files
  --map [--focus <p>] [--tokens <n>]
                       token-budgeted ranked digest (--focus personalizes)
  --symbols [n]        top-n Aider-style ranked symbols (default 30)
  --feature <name>     files composing a feature + external dependents
  --features           list all features (route segments) by size
  --hubs               top files by PageRank importance
  --print              dump the full cached map as JSON
  (no flags)           build the map + print a one-line summary

Global modifier:
  --json               emit exactly one JSON object (no prose) for the command

Maintenance:
  --install-hooks [--dry-run]
                       install git post-commit + copy the PreToolUse nudge +
                       wire .claude/settings.json (--dry-run = preview, no writes)
  --setup-mcp [--dry-run]
                       configure MCP server for OpenCode & Antigravity IDE
                       (--dry-run = preview, no writes)
  --mcp                start a stdio MCP server (for MCP-capable agents)
  --help, -h           show this help
  --version, -v        print the version

Exit codes: 0 ok · 1 query had zero results · 2 usage error.`;

// --help / --version short-circuit BEFORE any build or dispatch.
if (has("--help") || has("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (has("--version") || has("-v")) {
  let version = "0.0.0";
  try { version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version || version; } catch {}
  console.log(version);
  process.exit(0);
}

// --mcp: hand off to the stdio MCP server (authored separately). Dynamic import
// so a missing mcp.mjs only fails when --mcp is actually requested.
if (has("--mcp")) {
  try {
    const m = await import(new URL("./mcp.mjs", import.meta.url));
    await m.serve();
  } catch (e) {
    console.error(`agentmap --mcp failed: ${e?.message || e}`);
    process.exit(1);
  }
}
// --install-hooks: wire the git post-commit refresh + emit the PreToolUse
// snippet. Self-contained (resolves the package hooks/ dir relative to here).
else if (has("--install-hooks")) {
  try { installHooks({ dryRun: has("--dry-run") }); process.exit(0); }
  catch (e) { console.error(`agentmap --install-hooks failed: ${e?.message || e}`); process.exit(1); }
}
// --setup-mcp: configure MCP server for OpenCode & Antigravity IDE.
else if (has("--setup-mcp")) {
  try { setupMcp({ dryRun: has("--dry-run") }); process.exit(0); }
  catch (e) { console.error(`agentmap --setup-mcp failed: ${e?.message || e}`); process.exit(1); }
}
// Unknown-flag guard: any "-"-prefixed token not in KNOWN → usage error (exit
// 2). Runs BEFORE the bare-build fallthrough so a typo never silently rebuilds.
// Bare invocation with NO flags still builds (handled in the final else).
else if (args.some((a, i) => a.startsWith("-") && !KNOWN.has(a) && !valueIdx.has(i))) {
  const bad = args.find((a, i) => a.startsWith("-") && !KNOWN.has(a) && !valueIdx.has(i));
  console.error(`unknown flag: ${bad}\ntry \`agentmap --help\` for the list of commands.`);
  process.exit(2);
}
else if (has("--any")) {
  // Unified router: cached structure (file → symbol → feature) then a LIVE
  // git-grep fallback for data/copy/string-literals the graph never indexes.
  const raw = arg("--any");
  if (!raw) { console.error('--any needs a query, e.g. `--any PremiumCard` or `--any "multi-modal"`'); process.exitCode = 2; }
  else {
    const q = raw.toLowerCase();
    const data = ensureFresh();
    const keys = Object.keys(data.files);
    const { key: fileKey, candidates } = resolveFile(keys, data.files, raw);
    // structured symbol/feature hits (reused by both prose + JSON shapes)
    const symObjs = [];
    for (const [path, f] of Object.entries(data.files))
      for (const e of f.exports)
        if (e.name.toLowerCase().includes(q)) symObjs.push({ file: path, name: e.name, kind: e.kind });
    const symHits = symObjs.map((s) => `  ${s.file} → ${s.name} (${s.kind})`);
    const featNames = Object.keys(data.features || {}).filter((k) => k.toLowerCase().includes(q));
    if (fileKey) {
      // A file resolved — but ALSO surface symbol/feature hits (fix #3) so a
      // loose path match (e.g. "auth") can't shadow a symbol the user wanted.
      const f = data.files[fileKey];
      out({ command: "any", query: raw, kind: "file", file: fileKey, pagerank: f.pagerank ?? null, exports: f.exports, imports: f.imports, dependents: f.dependents, symbols: symObjs, features: featNames.map((n) => ({ name: n, count: data.features[n].length })) }, () => {
        console.log(`[structure:file] ${fileKey}  (pr ${f.pagerank ?? "—"})`);
        fileBlock(fileKey, f);
        if (symHits.length) { console.log(`[structure] ${symHits.length} symbol match for "${raw}":`); console.log(symHits.join("\n")); }
        if (featNames.length) console.log("features: " + featNames.map((n) => `${n} (${data.features[n].length})`).join(", "));
      });
    } else if (symHits.length || featNames.length) {
      out({ command: "any", query: raw, kind: "structure", symbols: symObjs, features: featNames.map((n) => ({ name: n, count: data.features[n].length })) }, () => {
        console.log(`[structure] ${symHits.length} symbol, ${featNames.length} feature match for "${raw}"`);
        if (symHits.length) console.log(symHits.join("\n"));
        if (featNames.length) console.log("features: " + featNames.map((n) => `${n} (${data.features[n].length})`).join(", "));
      });
    } else if (candidates && candidates.length > 1) {
      out({ command: "any", query: raw, kind: "candidates", candidates }, () => {
        console.log(`[structure] "${raw}" matched ${candidates.length} files — narrow it:`);
        for (const k of candidates) console.log(`  ${k}`);
      });
    } else {
      const res = contentSearch(raw);
      if (!res) {
        process.exitCode = 1;
        out({ command: "any", query: raw, kind: "empty" }, () => console.log(`[content] 0 match for "${raw}" (git grep, tracked + untracked)`));
      } else {
        const lines = res.split("\n");
        const shown = lines.slice(0, CONTENT_LINES_LIMIT);
        out({ command: "any", query: raw, kind: "content", total: lines.length, lines: shown }, () => {
          console.log(`[content] ${lines.length} line${lines.length > 1 ? "s" : ""}${lines.length > CONTENT_LINES_LIMIT ? ` (showing ${CONTENT_LINES_LIMIT})` : ""}:`);
          console.log(shown.join("\n"));
        });
      }
    }
  }
} else if (has("--find")) {
  const raw = arg("--find");
  if (!raw) { console.error("--find needs a symbol query, e.g. `--find PremiumCard`"); process.exitCode = 2; }
  else {
    const q = raw.toLowerCase();
    const data = ensureFresh();
    const matches = [];
    for (const [path, f] of Object.entries(data.files))
      for (const e of f.exports)
        if (e.name.toLowerCase().includes(q)) matches.push({ file: path, name: e.name, kind: e.kind });
    if (!matches.length) process.exitCode = 1;
    out({ command: "find", query: raw, matches }, () => {
      console.log(`find "${raw}": ${matches.length} match`);
      if (matches.length) console.log(matches.map((m) => `  ${m.file} → ${m.name} (${m.kind})`).join("\n"));
    });
  }
} else if (has("--relates")) {
  const q = arg("--relates");
  if (!q) { console.error("--relates needs a file path/name, e.g. `--relates agentmap.mjs`"); process.exitCode = 2; }
  else {
    const data = ensureFresh();
    const keys = Object.keys(data.files);
    const { key, candidates } = resolveFile(keys, data.files, q);
    if (!key) {
      process.exitCode = 1;
      out({ command: "relates", error: "no match", query: q, candidates: candidates || [] }, () => {
        if (candidates && candidates.length > 1) { console.log(`relates: "${q}" matched ${candidates.length} files — narrow it:`); for (const k of candidates) console.log(`  ${k}`); }
        else console.log(`relates: no file matching "${q}"`);
      });
    } else {
      const f = data.files[key];
      // query-focused relevance: personalized PageRank (random-walk-with-restart)
      // on a BIDIRECTIONAL graph → files most related to the target, transitively.
      const biEdges = [];
      for (const [p, ff] of Object.entries(data.files))
        for (const tp of ff.imports) if (data.files[tp]) { biEdges.push({ from: p, to: tp, weight: 1 }); biEdges.push({ from: tp, to: p, weight: 1 }); }
      const rel = pagerank(keys, biEdges, { personalization: { [key]: 1 } });
      const top = Object.entries(rel).filter(([k]) => k !== key).sort((a, b) => b[1] - a[1]).slice(0, RELATED_LIMIT);
      out({ command: "relates", file: key, pagerank: f.pagerank ?? null, exports: f.exports, imports: f.imports, dependents: f.dependents, related: top.map(([file, score]) => ({ file, score: +score.toFixed(6) })) }, () => {
        console.log(`relates: ${key}  (pr ${f.pagerank ?? "—"})`);
        fileBlock(key, f);
        console.log(`related (random-walk relevance):`);
        for (const [k, r] of top) console.log(`  ${k} (${r.toFixed(4)})`);
      });
    }
  }
} else if (has("--map")) {
  // Token-budgeted ranked digest (Aider's killer feature). --focus <path>
  // personalizes toward a file; default budget FOCUS_BUDGET, ×8 with no focus.
  const focusArg = arg("--focus");
  // #14: `--focus` present but with NO value (it's the last arg, or another
  // flag follows) — warn + exit 2 instead of silently using the global budget.
  if (has("--focus") && focusArg === undefined) {
    console.error("--focus needs a file path/name, e.g. `--map --focus agentmap.mjs`");
    process.exitCode = 2;
  } else {
    const data = ensureFresh();
    const tk = parseInt(arg("--tokens") ?? "", 10);
    const budget = Number.isFinite(tk) && tk > 0 ? tk : (focusArg ? FOCUS_BUDGET : DEFAULT_BUDGET);
    let ranked = data.rankedSymbols || [];
    let focusLabel = "global";
    if (focusArg) {
      const { key, candidates } = resolveFile(Object.keys(data.files), data.files, focusArg);
      if (key) { ranked = rankSymbols(data.files, new Set([key])); focusLabel = key; }
      else console.error(`# warning: --focus "${focusArg}" matched ${(candidates && candidates.length) || 0} files — using global ranking`);
    }
    // Fallback for default-export-heavy repos (sparse named-symbol graph): build
    // the digest from file PageRank so --map is never empty.
    if (!ranked.length)
      ranked = Object.entries(data.files)
        .sort((a, b) => (b[1].pagerank || 0) - (a[1].pagerank || 0))
        .flatMap(([file, f]) => (f.exports || []).map((e) => ({ file, name: e.name, kind: e.kind, rank: f.pagerank || 0 })));
    // Budget the digest into per-file blocks; collect the SHOWN files (with the
    // exact symbols that fit) so prose + JSON render from one source of truth.
    let used = 0;
    const byFile = new Map();
    for (const s of ranked) { if (!byFile.has(s.file)) byFile.set(s.file, []); byFile.get(s.file).push(s); }
    const shownFiles = []; // [{ file, symbols:[{name,kind}] }]
    let first = true;
    for (const [file, syms] of byFile) {
      const capped = syms.slice(0, SYMS_PER_FILE);
      const lineOf = (arr) => `\n${file}:\n` + arr.map((s) => `  ${s.name} (${s.kind})`).join("\n");
      const t = tokEst(lineOf(capped));
      if (used + t > budget) {
        // #13: if the FIRST (highest-ranked) block alone overruns the budget,
        // emit a PARTIAL block (fewer symbols) so the top file is never wholly
        // omitted. Otherwise `continue` so smaller lower-ranked files can still
        // fill the remaining budget (don't `break` on the first overflow).
        if (first && budget > 0) {
          let partial = capped;
          while (partial.length > 1) {
            partial = partial.slice(0, partial.length - 1);
            const pt = tokEst(lineOf(partial));
            if (used + pt <= budget) { used += pt; shownFiles.push({ file, symbols: partial.map((s) => ({ name: s.name, kind: s.kind })) }); break; }
          }
          first = false;
        }
        continue;
      }
      used += t; first = false;
      shownFiles.push({ file, symbols: capped.map((s) => ({ name: s.name, kind: s.kind })) });
    }
    out({ command: "map", focus: focusLabel, budget, tokens: used, files: shownFiles }, () => {
      console.log(`# agentmap (${data.fileCount} files, sha ${data.generatedSha}) — focus: ${focusLabel}, budget ~${budget} tok`);
      for (const { file, symbols } of shownFiles)
        console.log(`\n${file}:\n` + symbols.map((s) => `  ${s.name} (${s.kind})`).join("\n"));
      console.log(`\n# ~${used} tokens (${shownFiles.length} files shown)`);
    });
  }
} else if (has("--symbols")) {
  const data = ensureFresh();
  const sn = parseInt(arg("--symbols") ?? "", 10); const n = Number.isFinite(sn) && sn > 0 ? sn : DEFAULT_SYMBOLS;
  const syms = (data.rankedSymbols || []).slice(0, n);
  out({ command: "symbols", symbols: syms.map((s) => ({ rank: s.rank, file: s.file, name: s.name, kind: s.kind })) }, () => {
    console.log(`top ${n} ranked symbols (Aider-style):`);
    for (const s of syms) console.log(`  ${s.rank}  ${s.file} → ${s.name} (${s.kind})`);
  });
} else if (has("--feature")) {
  const raw = arg("--feature");
  if (!raw) { console.error("--feature needs a name, e.g. `--feature dashboard` (run --features to list)"); process.exitCode = 2; }
  else {
  const q = raw.toLowerCase();
  const data = ensureFresh();
  const name = Object.keys(data.features).find((k) => k.toLowerCase() === q) || Object.keys(data.features).find((k) => k.toLowerCase().includes(q));
  if (!name) {
    process.exitCode = 1;
    out({ command: "feature", error: "no match", query: raw }, () => console.log(`feature: no match for "${raw}" — run --features to list them.`));
  } else {
    const fl = data.features[name], set = new Set(fl), exts = new Set();
    for (const p of fl) for (const dep of (data.files[p]?.dependents || [])) if (!set.has(dep)) exts.add(dep);
    out({ command: "feature", name, files: fl, externalDependents: [...exts] }, () => {
      console.log(`feature "${name}": ${fl.length} files`);
      for (const p of fl) console.log(`  ${p}`);
      console.log(`external dependents (${exts.size}): ${[...exts].join(", ") || "—"}`);
    });
  }
  }
} else if (has("--features")) {
  const data = ensureFresh();
  const list = Object.entries(data.features).map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1]);
  out({ command: "features", features: Object.fromEntries(list) }, () => {
    console.log(`features (${list.length}):`);
    for (const [k, n] of list) console.log(`  ${k} (${n} files)`);
  });
} else if (has("--hubs")) {
  const data = ensureFresh();
  out({ command: "hubs", fileCount: data.fileCount, sha: data.generatedSha, hubs: data.hubs }, () => {
    console.log(`agentmap: ${data.fileCount} files (sha ${data.generatedSha})`);
    console.log("hubs (PageRank importance):");
    for (const h of data.hubs) console.log(`  ${h}`);
  });
} else if (has("--print")) {
  const data = ensureFresh();
  // --print is already JSON-only; add top-level fileCount (was omitted before).
  console.log(JSON.stringify({ fileCount: data.fileCount, hubs: data.hubs, features: data.features, rankedSymbols: data.rankedSymbols, files: data.files }));
} else {
  // Bare invocation (possibly `--json` alone): build + one-line summary, or the
  // {command:"build", ...} JSON object.
  const built = build();
  const topHub = built.hubs[0] || null;
  out({ command: "build", fileCount: built.fileCount, features: Object.fromEntries(Object.entries(built.features).map(([k, v]) => [k, v.length])), topHub }, () => {
    console.log(`agentmap: ${built.fileCount} files | ${Object.keys(built.features).length} features | top hub: ${topHub || "—"}`);
  });
}
