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
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, readdirSync, lstatSync, chmodSync } from "node:fs";
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
const MAP_DIRTY = ".claude/agentmap/map.dirty.json"; // dirty-tree build cache, keyed by dirtyFingerprint (Batch 3 Tier 1)
const FACTS = ".claude/agentmap/facts.json"; // raw per-file facts snapshot for incremental rebuild (Batch 3 Tier 2)
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

// ---------------------------------------------------------------------------
// TS/JS backend descriptor — the single source of truth for which extensions
// this backend handles. Hoisted out of the 5 sites that used to hardcode the
// list (dirty-check, source fingerprint, ts-morph discovery, non-git glob
// fallback, specifier resolution) so a second-language backend can be a drop-in
// later (Batch 2 seam). Regex alternation order is irrelevant here — each source
// path ends in exactly one extension — so one canonical list stays behavior-
// identical to the old per-site orderings.
//
//   CODE_EXT   — extensions ts-morph parses directly. `.vue` is deliberately
//                NOT here: a Vue SFC is not TS/JS, so it's indexed via a virtual
//                `.vue.ts`/`.vue.js` source (see extractVueScripts), not handed
//                to ts-morph raw.
//   SOURCE_EXT — everything that counts as a "source file" for freshness / dirty
//                detection. INCLUDES `.vue` so editing an SFC busts the cache.
// ---------------------------------------------------------------------------
const CODE_EXT = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
const SOURCE_EXT = [...CODE_EXT, "vue"];
const extBrace = (list) => `{${list.join(",")}}`;                 // glob brace body
const CODE_EXT_RE = new RegExp(`\\.(${CODE_EXT.join("|")})$`);    // ts-morph-parseable files
const SOURCE_EXT_RE = new RegExp(`\\.(${SOURCE_EXT.join("|")})$`); // any source file (incl. .vue)

const sh = (c) => { try { return execSync(c, { stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAXBUF }).toString().trim(); } catch { return ""; } };

// Live content search for the --any fallback. `git grep` over tracked +
// untracked files (skips gitignored paths like node_modules). Reads DISK, so
// never stale. -F = fixed-string so literals like "bg-[#faf8f2]" aren't regex.
// -i = case-insensitive BY DESIGN (discovery ergonomics, matches --find which
// lowercases its query): a "content" hit may differ in case from the query as
// typed, but every match is printed verbatim with file:line so the true casing
// is always visible — results are a superset, never a falsified exact-case hit.
// stderr ignored so "fatal: not a git repository" stays quiet in non-git repos.
// Exclude sensitive files from the --untracked sweep so a local .env / key /
// secrets file never gets scanned and surfaced (and via MCP fed to an LLM).
// Mix of path globs (env/key/cert/SSH-key shapes) and case-insensitive name
// matches (anything *secret* / *credential* / *password*). These are pathspecs,
// not regexes — git applies them as exclusions to the search tree.
const SENSITIVE_EXCLUDES = [
  ":!.env", ":!.env.*", ":!**/.env", ":!**/.env.*",
  // also any *.env (e.g. prod.env, .env.local already covered above) at any depth
  ":!*.env", ":!**/*.env",
  ":!*.pem", ":!*.key", ":!*.p12", ":!*.pfx", ":!*.crt", ":!id_rsa*",
  // more private-key / keystore shapes + SSH key variants beyond id_rsa.
  ":!*.p8", ":!*.jks", ":!*.keystore", ":!id_ed25519*", ":!id_ecdsa*",
  // conventionally-named credential dotfiles (root + any depth). Deliberately NOT
  // a broad `*token*` name match — that would over-exclude source files like
  // tokenizer.ts / token.ts / useToken.tsx from the content search.
  ":!.npmrc", ":!**/.npmrc", ":!.netrc", ":!**/.netrc",
  ":!.git-credentials", ":!**/.git-credentials", ":!.pgpass", ":!**/.pgpass",
  ":!.htpasswd", ":!**/.htpasswd", ":!.pypirc", ":!**/.pypirc",
  // name-substring matches: `*password*` (not `*.password*`) so a plain
  // password.txt / passwords.json is excluded, not just foo.password.ts.
  ":(exclude,icase)*secret*", ":(exclude,icase)*credential*", ":(exclude,icase)*password*",
];
const contentSearch = (q) => {
  try {
    return execFileSync("git", ["grep", "-F", "--untracked", "-n", "-i", "-I", "-e", q, "--", ".", ":!.claude/agentmap/", ...SENSITIVE_EXCLUDES], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAXBUF }).trim();
  } catch { return ""; }
};
const currentSha = () => sh("git rev-parse --short HEAD");
// Parse `git status --porcelain` into the list of DIRTY SOURCE files — the work
// list that both the dirty gate (dirtyCount) and the dirty-map cache key
// (dirtyFingerprint) read, so the count and the key can never diverge. Each
// entry: { code, path, oldPath? }. `oldPath` is captured for rename/copy entries
// (Tier 2 needs it; the count/filter below is unaffected, keeping dirtyCount
// byte-identical to the old inline implementation).
// --untracked-files=all so a new file inside a brand-new untracked DIR is listed
// individually (default "all" folds it to "?? newdir/" and the extension regex
// misses it → a STALE cache would be served).
function dirtyFiles() {
  // Raw (UNTRIMMED) git output: `sh()` trims, which strips the leading space of
  // an unstaged " M path" line and shifts the fixed-column parse (dropping the
  // path's first char). dirtyCount only tested the extension suffix so it still
  // counted correctly, but the fingerprint needs the true path for lstat.
  let raw;
  try { raw = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAXBUF }); }
  catch { return []; } // not a git repo / git failure → treat as no dirty files
  const out = [];
  for (const l of raw.split("\n")) {
    if (!l) continue;
    const code = l.slice(0, 2);                          // porcelain status code (XY)
    let p = l.slice(3);                                  // strip "XY " status prefix
    let oldPath;
    // only rename/copy entries use the ` old -> new ` form — gating on the status
    // code avoids falsely splitting a plain file whose NAME contains " -> ".
    if (/[RC]/.test(code) && p.includes(" -> ")) {
      const parts = p.split(" -> ");
      oldPath = parts[0].replace(/^"|"$/g, "");          // rename/copy: remember old path
      p = parts.pop();                                   // …keep new path
    }
    p = p.replace(/^"|"$/g, "");                         // unquote space/special paths
    if (SOURCE_EXT_RE.test(p)) out.push({ code, path: p, oldPath }); // same filter as before → count identical
  }
  return out;
}
const dirtyCount = () => dirtyFiles().length;
const tokEst = (s) => Math.ceil((s || "").length / 4); // rough chars/4 estimate

// get-or-init a Map value (readable replacement for the dense `m.get(k) ?? m.set(...)` idiom).
const getOrSet = (m, k, make) => { let v = m.get(k); if (v === undefined) { v = make(); m.set(k, v); } return v; };

// Best-effort source fingerprint for NON-git repos (sha == ""). Hash of sorted
// "path:mtimeMs:size" for source files so the cache can be trusted between runs
// without a full reparse. Skips node_modules/.git/.next. Any error ⇒ "" (caller
// falls through to build, i.e. current behavior). Never used on the git path.
// SOURCE_EXT_RE includes `.vue` so editing a Vue SFC invalidates the cache too.
function sourceFingerprint() {
  try {
    const entries = [];
    const walk = (dir, depth) => {
      if (depth > 40) return; // depth cap — don't fully walk a pathologically deep tree
      // per-directory try/catch: a single permission-denied subdir must NOT abort
      // the WHOLE walk (that would return "" and silently disable caching) — skip
      // the unreadable dir and keep going so the fingerprint stays usable.
      let names; try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (name === "node_modules" || name === ".git" || name === ".next") continue;
        const full = dir + "/" + name;
        let st;
        // lstatSync (NOT statSync) so a symlink reports as a symlink instead of
        // its target. Symlinked entries are SKIPPED entirely — never recursed
        // into, never stat'd through — so a circular symlink can't cause infinite
        // recursion / stack overflow.
        try { st = lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(full, depth + 1);
        else if (SOURCE_EXT_RE.test(name)) entries.push(`${full}:${st.mtimeMs}:${st.size}`);
      }
    };
    walk(".", 0);
    entries.sort();
    return createHash("sha1").update(entries.join("\n")).digest("hex");
  } catch { return ""; }
}

// Fingerprint of the DIRTY working-tree state for the dirty-map cache (Tier 1).
// sha1 over HEAD sha + sorted per-dirty-file tokens: an existing file →
// "path:mtimeMs:size" (mirrors sourceFingerprint, and only lstat's the handful
// of dirty files, not the whole tree); a deleted/unstattable file → "CODE:path";
// a rename additionally appends "R:old->new" so it can't collide with an
// independent add+delete. HEAD is included so the same edit against a different
// HEAD keys differently. The key changes iff the dirty rebuild's output would.
function dirtyFingerprint(sha, list) {
  const toks = [];
  for (const { code, path, oldPath } of list) {
    let tok;
    try { const st = lstatSync(path); tok = `${path}:${st.mtimeMs}:${st.size}`; }
    catch { tok = `${(code || "").trim() || "?"}:${path}`; }   // deleted / unstattable
    if (oldPath) tok += ` R:${oldPath}->${path}`;         // rename ≠ add+delete
    toks.push(tok);
  }
  toks.sort();
  return createHash("sha1").update("HEAD:" + sha + "\n" + toks.join("\n")).digest("hex");
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

// Read baseUrl+paths from a tsconfig/jsconfig file. Returns null when absent.
// Follows `extends` recursively (depth-capped) so a package tsconfig that only
// `extends` a shared base (Turborepo tsconfig.base.json holding all `paths`)
// still contributes its inherited baseUrl/paths. Child overrides parent.
function readTsconfigAliasOpts(cfgPath, _depth = 0) {
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8")) || {};
    const co = raw.compilerOptions || {};
    // Resolve inherited opts from `extends` first (parent), then layer self on top.
    let inherited = null;
    if (raw.extends && _depth < 10) {
      const exts = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
      const here = dirname(cfgPath);
      for (const ext of exts) {
        if (typeof ext !== "string" || !ext) continue;
        // Only resolve path-like extends (./, ../, absolute). Bare package
        // extends (e.g. "@tsconfig/strict") live in node_modules and don't
        // carry repo-local `paths`, so skip them safely.
        if (!/^(\.\.?\/|\/)/.test(ext)) continue;
        let base = join(here, ext);
        if (!existsSync(base) && existsSync(base + ".json")) base += ".json";
        else if (!/\.json$/.test(base) && existsSync(join(base, "tsconfig.json"))) base = join(base, "tsconfig.json");
        if (!existsSync(base)) continue;
        const parent = readTsconfigAliasOpts(base, _depth + 1);
        if (parent) inherited = { ...(inherited || {}), ...parent };
      }
    }
    const self = {};
    if (co.baseUrl) self.baseUrl = co.baseUrl;
    if (co.paths) self.paths = co.paths;
    const out = { ...(inherited || {}), ...self };
    if (!Object.keys(out).length) return null;
    return out;
  } catch { return null; }
}

// Collect package-level alias configs from tsconfig/jsconfig files in the repo.
// Deepest-dir-first sort so nearestAliasConfig can pick the longest prefix match.
function discoverPackageAliasConfigs(rootAbs, listed) {
  const root = rootAbs.replace(/\\/g, "/");
  const configs = [];
  const cfgRels = listed.length
    ? listed.filter((f) => /(^|\/)tsconfig\.json$/.test(f) || /(^|\/)jsconfig\.json$/.test(f))
    : [];
  for (const rel of cfgRels) {
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    const opts = readTsconfigAliasOpts(full);
    if (!opts) continue;
    configs.push({
      dir: join(root, dirname(rel)).replace(/\\/g, "/"),
      baseUrl: opts.baseUrl || ".",
      paths: opts.paths || {},
    });
  }
  configs.sort((a, b) => b.dir.length - a.dir.length);
  return configs;
}

// Longest matching tsconfig dir wins (monorepo package boundary).
function nearestAliasConfig(fromAbsDir, configs, rootAbs, rootOpts) {
  const norm = fromAbsDir.replace(/\\/g, "/");
  let best = null;
  for (const c of configs) {
    const d = c.dir;
    if (norm === d || norm.startsWith(d + "/")) { best = c; break; } // configs sorted deepest-first
  }
  if (best) return best;
  return { dir: rootAbs, baseUrl: rootOpts.baseUrl || ".", paths: rootOpts.paths || {} };
}

// Construct a ts-morph Project robustly: use tsconfig.json when present + valid;
// else (missing / malformed / solution-style references that index 0 files) fall
// back to broad source globs so the tool degrades gracefully instead of crashing.
function makeProject(inc = null) {
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
        const opts = readTsconfigAliasOpts(cfg);
        if (opts) return opts;
      } catch { /* ignore — proceed without paths */ }
    }
    return {};
  })();

  // ---- Tier 2 INCREMENTAL project construction --------------------------------
  // Parse ONLY the changed files (real content); add empty ts-morph stubs for
  // every OTHER cached key so a changed file's import edges resolve to exactly the
  // same keys a full build would — without paying to parse unchanged content.
  // tsconfig is intentionally NOT auto-loaded (that eagerly parses the whole tree,
  // the cost we're avoiding); alias resolution still works via aliasOpts +
  // packageAliasConfigs. Vue `<script>` blocks for changed .vue files are parsed
  // as virtual sources; unchanged .vue keys become resolution-only vueReal marks.
  if (inc) {
    const cwdp = process.cwd().replace(/\\/g, "/");
    const seg = (f) => { const s = f.split("/"); return s.includes("node_modules") || s.includes(".next"); };
    const project = new Project({ compilerOptions: { allowJs: true, ...aliasOpts }, ...FAST });
    const changedSet = new Set(inc.changed);
    const vueFiles = [];
    const changedCode = [];
    for (const f of inc.changed) {
      if (seg(f)) continue;
      if (CODE_EXT_RE.test(f)) changedCode.push(f);
      else if (f.endsWith(".vue")) vueFiles.push(f);
    }
    if (changedCode.length) project.addSourceFilesAtPaths(changedCode);
    const vueMap = Object.create(null);
    const vueReal = Object.create(null);
    for (const key of inc.cachedKeys) {
      if (changedSet.has(key) || seg(key)) continue;
      if (key.endsWith(".vue")) vueReal[`${cwdp}/${key}`] = true;                       // resolution target only
      else if (CODE_EXT_RE.test(key)) { try { project.createSourceFile(`${cwdp}/${key}`, "", { overwrite: true }); } catch {} }
    }
    // Config discovery must see the SAME input as a full build (git ls-files
    // includes package.json/tsconfig.json, which the source-only cachedKeys don't)
    // so monorepo alias resolution matches. Cheap — no source parsing.
    const listed = sh("git ls-files --cached --others --exclude-standard").split("\n").filter(Boolean);
    const packageAliasConfigs = discoverPackageAliasConfigs(cwdp, listed);
    for (const f of vueFiles) {
      let text; try { text = readFileSync(f, "utf8"); } catch { continue; }
      const block = extractVueScripts(text);
      if (!block || !block.text.trim()) continue;
      const vpath = vueVirtualPath(f, block.lang);
      project.createSourceFile(`${cwdp}/${vpath}`, block.text, { overwrite: true });
      vueMap[`${cwdp}/${vpath}`] = `${cwdp}/${f}`;
      vueReal[`${cwdp}/${f}`] = true;
    }
    return { project, vueMap, vueReal, aliasOpts, packageAliasConfigs };
  }
  // ---- end incremental --------------------------------------------------------

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
  const packageAliasConfigs = discoverPackageAliasConfigs(cwdp, listed);
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
      if (CODE_EXT_RE.test(f)) {
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
    const g = extBrace(CODE_EXT); // e.g. {ts,tsx,mts,cts,js,jsx,mjs,cjs}
    project.addSourceFilesAtPaths([
      `src/**/*.${g}`, `app/**/*.${g}`,
      `components/**/*.${g}`, `lib/**/*.${g}`,
      `pages/**/*.${g}`, `*.${g}`,
    ]);
    // Non-git `.vue` fallback: walk the tree like sourceFingerprint() does.
    try {
      const walk = (dir, depth) => {
        if (depth > 40) return; // depth cap, matching sourceFingerprint()
        let names; try { names = readdirSync(dir); } catch { return; } // skip unreadable dir, don't abort the whole walk
        for (const name of names) {
          if (name === "node_modules" || name === ".git" || name === ".next") continue;
          const full = dir + "/" + name;
          // lstatSync (NOT statSync) + skip symlinks, matching sourceFingerprint():
          // a circular symlink would otherwise recurse until the stack overflows.
          let st; try { st = lstatSync(full); } catch { continue; }
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) walk(full, depth + 1);
          else if (name.endsWith(".vue")) vueFiles.push(full.replace(/^\.\//, ""));
        }
      };
      walk(".", 0);
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
  return { project, vueMap, vueReal, aliasOpts, packageAliasConfigs };
}

// ---------------------------------------------------------------------------
// extractFacts() — the language-BACKEND boundary. Parse the repo and return
// per-file "facts": for each in-project source file, its exported symbols, the
// files it imports (+ the named symbols crossing each edge), pass-through
// re-exports, and which export is `default`. This is the ONLY function that
// knows about ts-morph and Vue SFCs; build() assembles the graph + rankings
// from these facts and is backend-agnostic. A second language = a second
// producer of this same shape (the Batch 2 seam). Operates on process.cwd().
//
// Returns { [relPath]: {
//   exports:         [{ name, kind }],
//   imports:         [targetPath…],                    // = Object.keys(importedSymbols)
//   importedSymbols: { [targetPath]: [names…] },        // "default"/"*" still literal
//   defaultExportName: string | null,                   // resolved default-export name
//   reExports:       [names…],                          // pass-through re-exports (barrels)
// } }
// A single pathological file is skipped + warned, never fatal (graceful degrade).
// ---------------------------------------------------------------------------
function extractFacts(inc = null) {
  const { project, vueMap, vueReal, aliasOpts, packageAliasConfigs } = makeProject(inc);
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
  const files = {};
  // PATH-SEGMENT exclusion (not substring) so e.g. components/.next-demo or
  // src/node_modules_helper.ts are NOT wrongly excluded.
  const excluded = (p) => { const segs = p.split("/"); return segs.includes("node_modules") || segs.includes(".next"); };

  // Resolve a relative module specifier (from the importing file's dir) to an
  // in-project source file key. Tries the bare path, then each extension, then
  // /index.*. Returns the rel key or null. Powers side-effect (6b) + dynamic
  // import()/require() (6c) edges that ts-morph's specifier resolution skips.
  const RES_EXT = CODE_EXT;
  // posix-join that collapses "" / "." / ".." segments (no fs access).
  const joinPosix = (a, b) => {
    const parts = (a + "/" + b).split("/"); const st = [];
    for (const seg of parts) { if (seg === "" || seg === ".") continue; if (seg === "..") st.pop(); else st.push(seg); }
    return (a.startsWith("/") ? "/" : "") + st.join("/");
  };
  // resolve an absolute-ish path to an in-project source file, honoring
  // extensionless + /index.* + .vue resolution (shared by relative + alias paths).
  const tryResolveAt = (abs) => {
    if (vueReal[abs]) return rel(abs);
    let sf = project.getSourceFile(abs);
    if (!sf) for (const e of RES_EXT) { sf = project.getSourceFile(`${abs}.${e}`); if (sf) break; }
    if (!sf) for (const e of RES_EXT) { sf = project.getSourceFile(`${abs}/index.${e}`); if (sf) break; }
    if (sf) return rel(sf.getFilePath());
    if (vueReal[`${abs}.vue`]) return rel(`${abs}.vue`);
    return null;
  };
  // #3 fix + monorepo: tsconfig/jsconfig baseUrl+paths alias resolution ("@/x",
  // "#/x", "~/x") for side-effect/dynamic/require edges AND static imports when
  // ts-morph can't resolve (cwd tsconfig lacks package paths). Per importing
  // file, use the nearest discovered tsconfig paths.
  const ROOTABS = process.cwd().replace(/\\/g, "/");
  const resolveAlias = (spec, fromAbsDir) => {
    const cfg = nearestAliasConfig(fromAbsDir, packageAliasConfigs, ROOTABS, aliasOpts);
    const aliasBase = joinPosix(cfg.dir, cfg.baseUrl || ".");
    const aliasEntries = Object.entries(cfg.paths || {});
    for (const [pat, targets] of aliasEntries) {
      const star = pat.indexOf("*");
      let sub = null;
      if (star === -1) { if (spec === pat) sub = ""; else continue; }
      else {
        const pre = pat.slice(0, star), suf = pat.slice(star + 1);
        if (spec.length < pre.length + suf.length || !spec.startsWith(pre) || !spec.endsWith(suf)) continue;
        sub = spec.slice(pre.length, spec.length - suf.length);
      }
      for (const tRaw of (Array.isArray(targets) ? targets : [targets])) {
        const tStar = tRaw.indexOf("*");
        const candidate = tStar === -1 ? tRaw : tRaw.slice(0, tStar) + sub + tRaw.slice(tStar + 1);
        const hit = tryResolveAt(joinPosix(aliasBase, candidate));
        if (hit) return hit;
      }
    }
    return null;
  };
  // Resolve a module specifier to an in-project file key. A relative specifier is
  // joined against the importer's dir and handed to tryResolveAt — which already
  // encodes the full precedence ladder (exact `.vue` wins → extensionless →
  // `.ext` TS/JS shadow → `/index.ext` → `.vue` fallback). A bare specifier goes
  // through the tsconfig/jsconfig alias resolver. (The relative branch used to
  // re-implement tryResolveAt's ladder behind a `join` local that shadowed
  // joinPosix — collapsed here to the one shared joinPosix + tryResolveAt.)
  const resolveSpec = (fromAbsDir, spec) =>
    spec.startsWith(".") ? tryResolveAt(joinPosix(fromAbsDir, spec)) : resolveAlias(spec, fromAbsDir);

  const sourceFiles = project.getSourceFiles();
  // In incremental mode only the changed files carry real content; the rest are
  // empty resolution stubs. Extract facts for the changed set only (stubs would
  // otherwise overwrite good cached facts with empty ones).
  const only = inc ? new Set(inc.changed) : null;
  process.stderr.write(`# agentmap: parsing ${only ? only.size : sourceFiles.length} source files${inc ? " (incremental)" : ""}…\n`);
  for (const sf of sourceFiles) {
    const path = rel(sf.getFilePath());
    if (excluded(path)) continue;
    if (only && !only.has(path)) continue;
    try {
    const fromDir = sf.getDirectoryPath().replace(/\\/g, "/");
    const reExports = new Set(); // #2: names that are pass-through re-exports, not real uses
    // Files this file re-exports FROM (`export … from './x'`). Its `exports` list
    // transitively includes those targets' exports (getExportedDeclarations follows
    // the re-export), so re-parsing it in incremental mode against EMPTY stubs would
    // drop them. Tier 2 declines incremental when a re-export touches the changed
    // set. INTERNAL — stripped in assemble() so it never reaches map.json.
    const reExportsFrom = new Set();
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
        // 6b: side-effect or alias import — ts-morph may not resolve when cwd
        // tsconfig lacks package paths; resolveSpec uses nearest tsconfig paths.
        const spec = imp.getModuleSpecifierValue();
        const tp = resolveSpec(fromDir, spec);
        if (tp) {
          const names = imp.getNamedImports().filter((n) => !n.isTypeOnly()).map((n) => n.getName());
          if (imp.getDefaultImport()) names.push("default");
          if (imp.getNamespaceImport()) names.push("*");
          addEdge(tp, names.length ? names : ["*"]);
        }
      }
    }
    for (const exp of sf.getExportDeclarations()) {
      if (exp.isTypeOnly()) continue; // type-only re-exports excluded from edges
      const t = exp.getModuleSpecifierSourceFile();
      if (t) {
        const tp = rel(t.getFilePath());
        const names = exp.getNamedExports().filter((n) => !n.isTypeOnly()).map((n) => n.getName());
        addEdge(tp, names);                     // keep the FILE-level edge (barrel depends on origin)
        reExportsFrom.add(tp);                  // this file's exports transitively depend on tp's content
        for (const n of names) reExports.add(n); // #2: mark as re-export so rankSymbols won't count it as a reference
      }
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
    files[path] = { exports, imports, importedSymbols, defaultExportName, reExports: [...reExports], reExportsFrom: [...reExportsFrom] };
    } catch (e) {
      // #1 fix: a single pathological file (malformed import specifier, ts-morph
      // edge case) must NOT abort the whole map — skip it + warn, preserving the
      // graceful-degradation contract agentmap advertises.
      process.stderr.write(`# agentmap: skipped ${path} (parse error: ${e?.message ?? e})\n`);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// build() — backend-agnostic assembly. Take per-file facts from extractFacts(),
// resolve default-import edges, invert dependents, group features, compute file
// PageRank + the Aider-style symbol ranking, pick hubs, and persist the cache.
// Knows nothing about ts-morph / Vue — swapping the backend never touches this.
// ---------------------------------------------------------------------------
function build({ target = MAP, extra = null } = {}) {
  const t0 = Date.now();
  return assemble(extractFacts(), { target, extra, t0 });
}

// assemble() — the backend-agnostic graph assembly + persistence shared by the
// full build() and the Tier 2 incremental rebuild. Takes raw per-file facts
// (exports/imports/importedSymbols/defaultExportName/reExports), resolves
// default-import edges, inverts dependents, groups features, computes file
// PageRank + the Aider-style symbol ranking, picks hubs, and persists the cache.
// MUTATES `files`, so incremental passes a disposable copy.
function assemble(files, { target = MAP, extra = null, t0 = Date.now() } = {}) {
  // Snapshot raw facts BEFORE the mutations below so a CLEAN build can persist
  // them (Tier 2) for a later incremental rebuild. Clean builds only — a dirty or
  // incremental build never re-bases off its own output.
  const rawFacts = target === MAP ? structuredClone(files) : null;
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
  // Invert imports → dependents (who imports each file). Derived purely from the
  // facts, in the same file/import iteration order the in-loop build used, so the
  // per-file dependents arrays stay byte-identical.
  const dependents = {};
  for (const [p, f] of Object.entries(files)) for (const tp of f.imports) (dependents[tp] ??= []).push(p);
  for (const p in files) files[p].dependents = dependents[p] ?? [];

  // Group files into features (first real app/ route segment) from their paths.
  const features = {};
  for (const p of Object.keys(files)) { const feat = featureOf(p); if (feat) (features[feat] ??= []).push(p); }

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

  // defaultExportName was only needed for the fix-#7 post-pass, and reExportsFrom
  // only for Tier 2's re-export gate — drop both before persisting so the on-disk
  // `files` shape (map.json) stays byte-identical.
  for (const p of nodes) { delete files[p].defaultExportName; delete files[p].reExportsFrom; }

  const sha = currentSha();
  const out = {
    schema: SCHEMA_VERSION, generatedSha: sha, dirty: dirtyCount(), fileCount: nodes.length,
    // fingerprint lets non-git repos (sha === "") trust the cache across runs.
    fingerprint: sha ? undefined : sourceFingerprint(),
    hubs, features, rankedSymbols: rankedSymbols.slice(0, RANKED_SYMBOLS_LIMIT), files,
  };
  // `extra` (dirty-map cache key etc.) is merged for non-default targets only;
  // a default clean build passes extra=null so map.json stays byte-identical.
  if (extra) Object.assign(out, extra);
  mkdirSync(".claude/agentmap", { recursive: true });
  // Atomic write: tmp + rename so a concurrent background rebuild can never
  // expose a torn/truncated map to a reader.
  const tmp = target + ".tmp";
  writeFileSync(tmp, JSON.stringify(out));
  renameSync(tmp, target);
  // Tier 2: persist the raw facts snapshot for CLEAN git builds so a later dirty
  // query can reparse only the changed files instead of the whole repo. Never
  // fatal — the snapshot is a pure optimization.
  if (rawFacts && sha) {
    try {
      const ftmp = FACTS + ".tmp";
      writeFileSync(ftmp, JSON.stringify({ schema: SCHEMA_VERSION, generatedSha: sha, facts: rawFacts }));
      renameSync(ftmp, FACTS);
    } catch {}
  }
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
  for (const [p, f] of Object.entries(files)) {
    const reExp = new Set(f.reExports || []); // #2: pass-through re-exports aren't real references
    for (const tp of f.imports)
      for (const name of f.importedSymbols[tp] || [])
        if (name !== "*" && name !== "default" && !reExp.has(name)) getOrSet(references, name, () => []).push(p);
  }

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
  // Dirty git tree (Tier 1): the clean fast-path above didn't return, so either
  // HEAD/schema drifted or the tree is dirty. Serve a cached dirty build keyed by
  // the dirty file set so back-to-back queries on an UNCHANGED dirty tree reuse
  // ONE rebuild instead of re-parsing the whole repo every call. Sits outside the
  // map.json block so it runs even before the first clean build exists.
  if (sha) {
    const dl = dirtyFiles();
    if (dl.length) {                                     // provably dirty
      const dfp = dirtyFingerprint(sha, dl);
      if (existsSync(MAP_DIRTY)) {
        try {
          const dc = JSON.parse(readFileSync(MAP_DIRTY, "utf8"));
          if (dc.schema === SCHEMA_VERSION && dc.dirtyFingerprint === dfp) return dc;
        } catch {}
      }
      return buildDirty(sha, dl, dfp);
    }
  }
  return build();
}

// Produce the dirty-tree map and cache it to MAP_DIRTY, keyed by `dfp`. Tries the
// Tier 2 incremental path (reparse only changed files) first; on ANY miss or
// error it falls through to a full build() — incremental is a pure optimization
// and must never be the reason a query fails or returns a wrong map.
function buildDirty(sha, dirtyList, dfp) {
  // AGENTMAP_NO_INCREMENTAL forces the full dirty build — used by the regression
  // suite to prove the incremental map is byte-identical to a full rebuild.
  if (!process.env.AGENTMAP_NO_INCREMENTAL) {
    try {
      const inc = buildIncremental(sha, dirtyList, dfp);
      if (inc) return inc;
    } catch (e) {
      process.stderr.write(`# agentmap: incremental rebuild fell back to full build (${e?.message ?? e})\n`);
    }
  }
  return build({ target: MAP_DIRTY, extra: { dirtyFingerprint: dfp } });
}

// Tier 2 (true incremental) — reparse only the git-changed files against the
// cached clean-HEAD facts snapshot, merge, then re-run the (global but cheap)
// assembly. Returns the map object on success, or null to signal "fall back to a
// full dirty build" (no / mismatched facts snapshot). Correctness rests on: a
// file's own facts depend only on its own source (so unchanged cached facts stay
// valid); changed files' edges resolve against empty stubs of the unchanged files
// (same keys a full build produces); and every derived step (dependents, both
// PageRanks, features, hubs) is recomputed fully from the merged facts.
function buildIncremental(sha, dirtyList, dfp) {
  if (!sha || !existsSync(FACTS)) return null;
  let snap; try { snap = JSON.parse(readFileSync(FACTS, "utf8")); } catch { return null; }
  if (!snap || snap.schema !== SCHEMA_VERSION || snap.generatedSha !== sha || !snap.facts) return null;
  // Monorepo signals make the isolated-stub reparse diverge from ts-morph's
  // whole-repo resolution, so decline when present (the common single-package repo
  // is unaffected):
  //   • a NESTED tsconfig/jsconfig can redefine a ROOT alias to a different dir —
  //     the full build resolves via ts-morph's root-tsconfig-native resolution, the
  //     incremental resolver via the hand-rolled resolveAlias (nearest config);
  //   • a NESTED package.json makes a directory import (`import './mod'`) resolve
  //     via its "main" in a full build, but the incremental index-ladder ignores it.
  // Use the SAME listing discoverPackageAliasConfigs uses (--cached --others) so an
  // UNTRACKED config can't slip the guard. Cross-platform (no shell globbing).
  let listed = [];
  try { listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAXBUF }).split("\n"); } catch {}
  if (listed.some((f) => /\/(tsconfig|jsconfig)(\.[\w.-]+)?\.json$/.test(f))) return null;
  if (listed.some((f) => /\/package\.json$/.test(f) && !f.split("/").includes("node_modules"))) return null;
  const cached = snap.facts;
  // Incremental is byte-identical to a full rebuild ONLY when the file SET is
  // unchanged — every dirty entry must be a MODIFICATION of a file already in the
  // snapshot. Adds/deletes/renames are declined (return null → full dirty build,
  // still cached by Tier 1), because they:
  //   • change the `files` key ordering (a new file lands at a different position
  //     than ts-morph's full-build order → shifts rank tie-breaks), and
  //   • flip edges in UNCHANGED importers we don't re-parse (a full build drops an
  //     importer's edge to a deleted file, or forms one to a newly-added file).
  // A modification never changes the file set, and an importer's edge NAMES come
  // from its own (unchanged) import statement, so a pure-modify merge is exact.
  for (const { code, path, oldPath } of dirtyList) {
    if (oldPath) return null;                              // rename / copy
    if (!Object.hasOwn(cached, path)) return null;         // added / new-untracked file
    if ((code || "").includes("D")) return null;           // deleted (staged or worktree)
  }
  const changed = dirtyList.map((d) => d.path);            // all modifications of existing files
  const changedSet = new Set(changed);
  // Re-export hazard, REVERSE: an UNCHANGED barrel that `export … from` a changed
  // file derives its OWN exports from that file (getExportedDeclarations follows
  // the re-export). We don't re-parse the barrel, so its cached exports would go
  // stale. cached[].reExportsFrom is reliable (recorded at the clean build, where
  // targets were real). Decline → full dirty build (Tier-1 cached).
  for (const k in cached) {
    const rf = cached[k].reExportsFrom;
    if (rf) for (const t of rf) if (changedSet.has(t)) return null;
  }
  // Re-export hazard, FORWARD: a changed file that itself `export … from` another
  // module has its `exports` list transitively resolved through that target — which
  // is an EMPTY stub in incremental mode, so its exports would be incomplete. We
  // can't rely on ts-morph resolving the stub, so detect it syntactically on the
  // changed file's own text (resolution-independent). Decline → full build.
  const STAR_REEXPORT = /\bexport\s+(?:type\s+)?\*/;                       // export * / export * as / export type *
  const NAMED_REEXPORT = /\bexport\s+(?:type\s+)?\{[\s\S]*?\}\s*from\s*['"]/; // export { … } from '…' (multi-line)
  // CommonJS export forms: getExportedDeclarations() returns [] for `module.exports`
  // when the file is re-parsed in the isolated incremental project (it needs the
  // whole-repo module context), so the changed file's exports would collapse.
  const CJS_EXPORTS = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\bexport\s*=/;
  for (const p of changed) {
    let txt; try { txt = readFileSync(p, "utf8"); } catch { return null; }
    if (STAR_REEXPORT.test(txt) || NAMED_REEXPORT.test(txt) || CJS_EXPORTS.test(txt)) return null;
  }
  const fresh = extractFacts({ changed, cachedKeys: Object.keys(cached) }); // reparse changed only
  const merged = structuredClone(cached);                  // disposable copy (assemble mutates it)
  for (const p of changed) {
    if (!fresh[p]) return null;   // file dropped from the map (parse-skip / vue <script> removed) ⇒ set change ⇒ full build
    // Re-export hazard, LAUNDERED (`export default Imported` / `export { Imported as default }`
    // with no `from` clause): the export's declaration lives in another file, which is an EMPTY
    // stub here, so getExportedDeclarations() can't name it → kind "?" and defaultExportName
    // stays "default". A full build resolves the real name. Kind "?" is the tell — decline.
    if (fresh[p].exports.some((e) => e.kind === "?")) return null;
    merged[p] = fresh[p];
  }
  return assemble(merged, { target: MAP_DIRTY, extra: { dirtyFingerprint: dfp } });
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
// Shared hook-wiring identifiers — the SINGLE source of truth consumed by both
// the writer (installHooks) and the checker (collectHookStatus). Previously
// each redeclared its own copies (nudgeDestRel/IGNORE_LINE vs NUDGE_REL/
// MAP_IGNORE_LINE) kept in sync only by comments; now there's one definition.
// ---------------------------------------------------------------------------
// Marker string baked into hooks/post-commit — used by --hook-status to detect our
// hook even when chained with other tools in the same file.
const POST_COMMIT_MARKER = "agentmap — git post-commit hook";
const NUDGE_REL = ".claude/hooks/agentmap-nudge.mjs";
const MAP_IGNORE_LINE = ".claude/agentmap/";
const NUDGE_SETTINGS_PATH = ".claude/settings.json";
const NUDGE_CMD = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/agentmap-nudge.mjs"`;
const NUDGE_MATCHERS = ["Grep", "Bash"];

// True when a PreToolUse entry list already wires our nudge to `matcher`.
// Shared predicate: installHooks uses it to decide whether to add an entry,
// collectHookStatus uses it to report wired/missing per matcher.
function nudgeMatcherWired(entries, matcher) {
  return entries.some(
    (e) => e?.matcher === matcher && Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("agentmap-nudge")),
  );
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
  const nudgeDestRel = NUDGE_REL;

  // .gitignore line: ignore the namespaced map DIR (not the legacy single file).
  const IGNORE_LINE = MAP_IGNORE_LINE;
  const settingsPath = NUDGE_SETTINGS_PATH;

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
  const hasGrep = nudgeMatcherWired(settings.hooks.PreToolUse, "Grep");
  const hasBash = nudgeMatcherWired(settings.hooks.PreToolUse, "Bash");
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

// Collect hook wiring as structured data. `degradedOutsideGit` switches the
// outside-git behavior: --hook-status (legacy) bails out and prints one line,
// --doctor wants the remaining repo-local checks (nudge, PreToolUse, .gitignore)
// to keep running with the git-only ones marked `skipped`.
function collectHookStatus({ degradedOutsideGit = false } = {}) {
  const gitDir = sh("git rev-parse --git-dir");
  const insideGit = Boolean(gitDir);
  const checks = [];

  checks.push({
    name: "git-repo",
    label: "Git repo",
    status: insideGit ? "ok" : "skipped",
    detail: insideGit ? "detected" : "not inside a git repository",
  });

  if (!insideGit && !degradedOutsideGit) return { insideGit: false, checks };

  if (insideGit) {
    const postCommitPath = `${gitDir}/hooks/post-commit`;
    let detail = "not installed";
    let status = "missing";
    if (existsSync(postCommitPath)) {
      const body = readFileSync(postCommitPath, "utf8");
      if (body.includes(POST_COMMIT_MARKER)) {
        detail = "installed";
        status = "installed";
      } else {
        detail = "not installed (hook exists but agentmap not found)";
      }
    }
    checks.push({
      name: "post-commit",
      label: "post-commit",
      status,
      detail,
      path: postCommitPath,
      suggestion: status === "installed" ? null : "agentmap --install-hooks",
    });
  } else {
    checks.push({
      name: "post-commit",
      label: "post-commit",
      status: "skipped",
      detail: "not inside a git repository",
    });
  }

  const nudgeInstalled = existsSync(NUDGE_REL);
  checks.push({
    name: "nudge",
    label: `nudge (${NUDGE_REL})`,
    status: nudgeInstalled ? "installed" : "missing",
    detail: nudgeInstalled ? "installed" : "not installed",
    path: NUDGE_REL,
    suggestion: nudgeInstalled ? null : "agentmap --install-hooks",
  });

  const settingsPath = NUDGE_SETTINGS_PATH;
  let settings = null;
  let settingsInvalid = false;
  if (existsSync(settingsPath)) {
    try {
      settings = parseSettings(readFileSync(settingsPath, "utf8"), settingsPath);
    } catch {
      settingsInvalid = true;
    }
  }
  const entries = settings?.hooks?.PreToolUse || [];
  for (const matcher of NUDGE_MATCHERS) {
    let status, detail;
    if (settingsInvalid) {
      status = "invalid";
      detail = "not wired (invalid settings.json)";
    } else if (!existsSync(settingsPath)) {
      status = "missing";
      detail = "not wired";
    } else if (nudgeMatcherWired(entries, matcher)) {
      status = "wired";
      detail = "wired";
    } else {
      status = "missing";
      detail = "not wired";
    }
    checks.push({
      name: `pretooluse-${matcher.toLowerCase()}`,
      label: `PreToolUse(${matcher})`,
      status,
      detail,
      path: settingsPath,
      suggestion: status === "wired" ? null : "agentmap --install-hooks",
    });
  }

  if (insideGit || existsSync(".gitignore")) {
    const gitignoreOk = existsSync(".gitignore") &&
      readFileSync(".gitignore", "utf8").split(/\r?\n/).some((l) => l.trim() === MAP_IGNORE_LINE);
    checks.push({
      name: "gitignore",
      label: `.gitignore (${MAP_IGNORE_LINE})`,
      status: gitignoreOk ? "ok" : "missing",
      detail: gitignoreOk ? "ok" : "missing entry",
      path: ".gitignore",
      suggestion: gitignoreOk ? null : "agentmap --install-hooks",
    });
  } else {
    checks.push({
      name: "gitignore",
      label: `.gitignore (${MAP_IGNORE_LINE})`,
      status: "skipped",
      detail: "no .gitignore outside a git repository",
    });
  }

  return { insideGit, checks };
}

function hookStatus() {
  const { insideGit, checks } = collectHookStatus({ degradedOutsideGit: false });
  if (!insideGit) {
    console.log("not a git repository — run inside the repo you want to check");
    return;
  }
  for (const c of checks) {
    if (c.name === "git-repo") continue;
    console.log(`${c.label}: ${c.detail}`);
  }
}

// ---------------------------------------------------------------------------
// --doctor: read-only harness health report. doctor reports; it never repairs.
// Reuses collectHookStatus() (with degradedOutsideGit), the skill install-target
// metadata from skills/install.mjs, the 3 MCP targets from setupMcp(), and the
// module-local dirtyCount() — no new sources of truth, no writes anywhere.
// ---------------------------------------------------------------------------

// Same 3 targets setupMcp() writes — keep labels/paths aligned so doctor's
// "missing entry" actually maps to "agentmap --setup-mcp will add it here".
// Each target: the ONE definition consumed by both collectMcpStatus (checker:
// path/has) and setupMcp (writer: path/graft). Antigravity is written to BOTH
// its entries on purpose — older builds read only the IDE-specific
// ~/.gemini/antigravity path, newer unified builds read the shared
// ~/.gemini/config path, so writing both is version-proof.
const MCP_TARGETS = [
  {
    name: "opencode",
    label: "OpenCode",
    path: () => join(homedir(), ".config", "opencode", "opencode.json"),
    displayPath: "~/.config/opencode/opencode.json",
    has: (cfg) => Boolean(cfg?.mcp?.agentmap),
    objectPath: "mcp.agentmap",
    graft: (cfg, { command, args }) => { (cfg.mcp ??= {}).agentmap = { type: "stdio", command, args, enabled: true }; },
  },
  {
    name: "antigravity",
    label: "Antigravity IDE",
    path: () => join(homedir(), ".gemini", "antigravity", "mcp_config.json"),
    displayPath: "~/.gemini/antigravity/mcp_config.json",
    has: (cfg) => Boolean(cfg?.mcpServers?.agentmap),
    objectPath: "mcpServers.agentmap",
    graft: (cfg, { command, args }) => { (cfg.mcpServers ??= {}).agentmap = { command, args }; },
  },
  {
    name: "antigravity-shared",
    label: "Antigravity (shared)",
    path: () => join(homedir(), ".gemini", "config", "mcp_config.json"),
    displayPath: "~/.gemini/config/mcp_config.json",
    has: (cfg) => Boolean(cfg?.mcpServers?.agentmap),
    objectPath: "mcpServers.agentmap",
    graft: (cfg, { command, args }) => { (cfg.mcpServers ??= {}).agentmap = { command, args }; },
  },
];

async function collectSkillStatus({ expectedVersion, root }) {
  const { getSkillInstallTargets } = await import("./skills/install.mjs");
  const targets = getSkillInstallTargets({ platforms: "all", project: true, global: false, root });
  return targets.map((t) => {
    const installed = existsSync(t.dest);
    if (!installed) {
      return {
        name: t.name,
        label: `${t.label}${t.legacy ? " (legacy)" : ""}`,
        status: "missing",
        path: t.dest,
        expectedVersion,
        suggestion: "agentmap --install-skill",
      };
    }
    let actualVersion = null;
    if (existsSync(t.versionPath)) {
      try { actualVersion = readFileSync(t.versionPath, "utf8").trim(); } catch { actualVersion = null; }
    }
    if (!actualVersion) {
      return {
        name: t.name,
        label: `${t.label}${t.legacy ? " (legacy)" : ""}`,
        status: "installed",
        detail: "version unknown",
        path: t.dest,
        expectedVersion,
        suggestion: "agentmap --install-skill",
      };
    }
    if (actualVersion !== expectedVersion) {
      return {
        name: t.name,
        label: `${t.label}${t.legacy ? " (legacy)" : ""}`,
        status: "stale",
        detail: `installed ${actualVersion}, current ${expectedVersion}`,
        path: t.dest,
        actualVersion,
        expectedVersion,
        suggestion: "agentmap --install-skill",
      };
    }
    return {
      name: t.name,
      label: `${t.label}${t.legacy ? " (legacy)" : ""}`,
      status: "ok",
      path: t.dest,
      actualVersion,
      expectedVersion,
    };
  });
}

function collectMcpStatus() {
  return MCP_TARGETS.map((t) => {
    const path = t.path();
    if (!existsSync(path)) {
      return {
        name: t.name,
        label: t.label,
        status: "missing",
        detail: "config missing",
        path: t.displayPath,
        objectPath: t.objectPath,
        suggestion: "agentmap --setup-mcp",
      };
    }
    let cfg;
    try { cfg = parseSettings(readFileSync(path, "utf8"), path); }
    catch {
      return {
        name: t.name,
        label: t.label,
        status: "invalid",
        detail: "invalid JSON",
        path: t.displayPath,
        objectPath: t.objectPath,
        suggestion: `fix ${t.displayPath} then re-run agentmap --setup-mcp`,
      };
    }
    const wired = t.has(cfg);
    return {
      name: t.name,
      label: t.label,
      status: wired ? "wired" : "missing",
      detail: wired ? "wired" : "agentmap entry missing",
      path: t.displayPath,
      objectPath: t.objectPath,
      suggestion: wired ? null : "agentmap --setup-mcp",
    };
  });
}

function collectMapStatus() {
  const currentExists = existsSync(MAP);
  const legacyExists = existsSync(MAP_LEGACY);
  if (!currentExists && !legacyExists) {
    return [{
      name: "map-cache",
      label: "Map cache",
      status: "missing",
      detail: "no map cache found",
      path: MAP,
      suggestion: "agentmap",
    }];
  }
  const selectedPath = currentExists ? MAP : MAP_LEGACY;
  let cache;
  try { cache = JSON.parse(readFileSync(selectedPath, "utf8")); }
  catch {
    return [{
      name: "map-cache",
      label: "Map cache",
      status: "unknown",
      detail: "cache exists but could not be parsed",
      path: selectedPath,
      suggestion: "agentmap",
    }];
  }
  const sha = currentSha();
  const dirty = dirtyCount();
  const reasons = [];
  if (sha && cache.generatedSha && cache.generatedSha !== sha) {
    reasons.push(`generatedSha ${cache.generatedSha} differs from HEAD ${sha}`);
  }
  if (typeof cache.schema === "number" && cache.schema !== SCHEMA_VERSION) {
    reasons.push(`schema ${cache.schema} differs from current ${SCHEMA_VERSION}`);
  }
  if (dirty > 0) {
    reasons.push(`working tree has ${dirty} TS/JS/Vue source change(s)`);
  }
  if (reasons.length) {
    return [{
      name: "map-cache",
      label: "Map cache",
      status: "stale",
      detail: reasons.join("; "),
      path: selectedPath,
      suggestion: "agentmap",
    }];
  }
  return [{
    name: "map-cache",
    label: "Map cache",
    status: "ok",
    detail: currentExists ? "current cache path present" : "legacy cache path present",
    path: selectedPath,
  }];
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    return { name: pkg.name || "agentmap", version: pkg.version || "0.0.0" };
  } catch {
    return { name: "agentmap", version: "0.0.0" };
  }
}

async function collectDoctorReport() {
  const pkg = readPackageVersion();
  const cwd = process.cwd();
  const { insideGit, checks: hooks } = collectHookStatus({ degradedOutsideGit: true });
  const skills = await collectSkillStatus({ expectedVersion: pkg.version, root: cwd });
  const mcp = collectMcpStatus();
  const map = collectMapStatus();

  const all = [...hooks, ...skills, ...mcp, ...map];
  const suggestions = [...new Set(all.map((c) => c.suggestion).filter(Boolean))];
  const needsAttention = all.some((c) =>
    ["missing", "stale", "invalid"].includes(c.status)
  );
  const overall = !insideGit ? "degraded" : (needsAttention ? "needs attention" : "ok");

  return {
    command: "doctor",
    cwd,
    package: pkg,
    overall,
    checks: { hooks, skills, mcp, map },
    suggestions,
  };
}

function formatDoctorReport(report) {
  const lines = [];
  lines.push("agentmap doctor");
  lines.push(`cwd: ${report.cwd}`);
  lines.push(`package: ${report.package.name} ${report.package.version}`);
  lines.push(`overall: ${report.overall}`);
  lines.push("");

  // Repo-relative display for skill/rule paths (which arrive absolute from
  // getSkillInstallTargets). Hooks/MCP/map paths are already short. Keep the
  // absolute path in the JSON output for tests/tooling.
  const displayPath = (p) => {
    if (!p) return "";
    const cwd = report.cwd;
    if (p === cwd) return ".";
    if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
    return p;
  };

  const section = (title, checks) => {
    lines.push(title);
    for (const c of checks) {
      const detail = c.detail ? ` — ${c.detail}` : "";
      const path = c.path ? ` (${displayPath(c.path)})` : "";
      lines.push(`  ${c.label}: ${c.status}${path}${detail}`);
    }
    lines.push("");
  };

  section("Hooks", report.checks.hooks);
  section("Skills / Rules", report.checks.skills);
  section("MCP", report.checks.mcp);
  section("Map cache", report.checks.map);

  lines.push("Suggested next steps");
  if (!report.suggestions.length) {
    lines.push("  No action needed.");
  } else {
    for (const s of report.suggestions) lines.push(`  - ${s}`);
  }
  return lines.join("\n");
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

  if (dryRun) console.log("--dry-run: would configure MCP server (no changes written):");

  // Same MCP_TARGETS table collectMcpStatus() reads — one source of truth for
  // labels/paths; each entry's `graft` builds the writer's config shape.
  for (const { label, path: pathFn, graft } of MCP_TARGETS) {
    const path = pathFn();
    // Reuse parseSettings so JSONC (comments) is tolerated and a malformed file
    // throws a clear error WITHOUT clobbering the original (we never write on the
    // failure path, so no .bak dance is needed).
    let cfg = {};
    if (existsSync(path)) cfg = parseSettings(readFileSync(path, "utf8"), path);
    graft(cfg, { command, args });

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
// CLI — arg parsing + command dispatch. Lives inside main() so that IMPORTING
// this module (for the exported pure functions below) has zero side effects:
// no build, no cache write, no console output, no process.exit. main() runs
// only when the file is executed directly (see the import.meta.url guard at the
// very bottom — the same dual check mcp.mjs uses).
// ---------------------------------------------------------------------------
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
  --install-skill [--platform claude|cursor|codex|opencode|gemini|antigravity|copilot|agents|all] [--project|--global] [--dry-run]
                       install skills + always-on docs/hooks per platform
  --hook-status          report whether agentmap git/nudge wiring is installed
  --doctor             read-only health report: hooks, skills/rules, MCP wiring, map cache
                         (exits 0, suggests fix commands, never writes files)
  --setup-mcp [--dry-run]
                       configure MCP server for OpenCode & Antigravity IDE
                       (--dry-run = preview, no writes)
  --mcp                start a stdio MCP server (for MCP-capable agents)
  --help, -h           show this help
  --version, -v        print the version

Exit codes: 0 ok · 1 query had zero results (incl. --map --focus with no match) · 2 usage error · 3 maintenance command failed.`;

async function main() {
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
    "--help", "-h", "--version", "-v", "--install-hooks", "--hook-status", "--doctor", "--install-skill", "--platform", "--project", "--global",
    "--dry-run", "--setup-mcp", "--mcp",
    "--any", "--find", "--relates", "--map", "--focus", "--tokens",
    "--symbols", "--feature", "--features", "--hubs",
  ]);

  // A token consumed as the VALUE of a value-taking flag is never itself a flag —
  // so a dash-leading query like `--any "-O/bin/sh"` is bound as the query, not
  // mistaken for an unknown flag. (arg() already rejects a "--"-leading value, so
  // `--any --foo` still falls through to the missing-arg guard instead.)
  const VALUE_FLAGS = new Set(["--any", "--find", "--relates", "--feature", "--focus", "--tokens", "--symbols", "--platform"]);
  const valueIdx = new Set();
  for (let i = 0; i < args.length - 1; i++) if (VALUE_FLAGS.has(args[i])) valueIdx.add(i + 1);

  // --help / --version short-circuit BEFORE any build or dispatch.
  if (has("--help") || has("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  if (has("--version") || has("-v")) {
    console.log(readPackageVersion().version);
    process.exit(0);
  }

  // Unknown-flag guard: any "-"-prefixed token not in KNOWN → usage error (exit
  // 2). Runs BEFORE any command dispatch (incl. the maintenance flags below, each
  // of which process.exit()s in its own branch) so a typo never silently triggers
  // the wrong command or a bare build. A token bound as a value-flag's value
  // (valueIdx) is never treated as a flag.
  if (args.some((a, i) => a.startsWith("-") && !KNOWN.has(a) && !valueIdx.has(i))) {
    const bad = args.find((a, i) => a.startsWith("-") && !KNOWN.has(a) && !valueIdx.has(i));
    console.error(`unknown flag: ${bad}\ntry \`agentmap --help\` for the list of commands.`);
    process.exit(2);
  }

  // Declarative command table. The dispatch below is order-insensitive set
  // membership, so without this pass two commands at once (`--map --doctor`) or an
  // orphan sub-flag (`--focus` with no `--map`) is silently accepted — whichever
  // branch matches first wins, no warning. Each key is a command; its value lists
  // the sub-flags that only make sense with it. `--json` is a global modifier (not
  // a command) and is deliberately absent — valid with any command or with none.
  const COMMANDS = {
    "--mcp": [], "--install-hooks": ["--dry-run"],
    "--install-skill": ["--platform", "--project", "--global", "--dry-run"],
    "--hook-status": [], "--doctor": [], "--setup-mcp": ["--dry-run"],
    "--any": [], "--find": [], "--relates": [], "--map": ["--focus", "--tokens"],
    "--symbols": [], "--feature": [], "--features": [], "--hubs": [], "--print": [],
  };
  const presentCommands = Object.keys(COMMANDS).filter(has);
  if (presentCommands.length > 1) {
    console.error(`conflicting commands: ${presentCommands.join(", ")} — pass exactly one.\ntry \`agentmap --help\` for the list of commands.`);
    process.exit(2);
  }
  // sub-flag → its declared parent command(s). A sub-flag shared by two commands
  // (--dry-run: --install-hooks or --setup-mcp) is valid if ANY parent is present.
  const subFlagParents = new Map();
  for (const [cmd, subs] of Object.entries(COMMANDS))
    for (const sub of subs) getOrSet(subFlagParents, sub, () => []).push(cmd);
  for (const [sub, parents] of subFlagParents)
    if (has(sub) && !parents.some(has)) {
      console.error(`${sub} requires ${parents.join(" or ")} — got: ${args.join(" ") || "(none)"}\ntry \`agentmap --help\` for usage.`);
      process.exit(2);
    }

  // --mcp: hand off to the stdio MCP server (authored separately). Dynamic import
  // so a missing mcp.mjs only fails when --mcp is actually requested.
  if (has("--mcp")) {
    try {
      const m = await import(new URL("./mcp.mjs", import.meta.url));
      await m.serve();
    } catch (e) {
      console.error(`agentmap --mcp failed: ${e?.message || e}`);
      process.exit(3);
    }
  }
  // --install-hooks: wire the git post-commit refresh + emit the PreToolUse
  // snippet. Self-contained (resolves the package hooks/ dir relative to here).
  else if (has("--install-hooks")) {
    try { installHooks({ dryRun: has("--dry-run") }); process.exit(0); }
    catch (e) { console.error(`agentmap --install-hooks failed: ${e?.message || e}`); process.exit(3); }
  }
  // --install-skill: copy packaged SKILL.md / Cursor rule (see skills/install.mjs).
  else if (has("--install-skill")) {
    try {
      // lazy import keeps skills/install.mjs (and its package.json read) OFF the
      // hot path — warm --any/--find queries must not load it.
      const { installSkill } = await import("./skills/install.mjs");
      installSkill({
        platforms: arg("--platform") || "all",
        project: !has("--global"),
        global: has("--global"),
        dryRun: has("--dry-run"),
      });
      process.exit(0);
    } catch (e) {
      console.error(`agentmap --install-skill failed: ${e?.message || e}`);
      process.exit(3);
    }
  }
  // --hook-status: report post-commit / nudge / settings wiring (no writes).
  else if (has("--hook-status")) {
    try { hookStatus(); process.exit(0); }
    catch (e) { console.error(`agentmap --hook-status failed: ${e?.message || e}`); process.exit(3); }
  }
  // --doctor: read-only harness health report (hooks + skills + MCP + map cache).
  // Always exits 0; never writes. --json emits the structured report.
  else if (has("--doctor")) {
    try {
      const report = await collectDoctorReport();
      if (wantJson) console.log(JSON.stringify(report, null, 2));
      else console.log(formatDoctorReport(report));
      process.exit(0);
    } catch (e) {
      console.error(`agentmap --doctor failed: ${e?.message || e}`);
      process.exit(3);
    }
  }
  // --setup-mcp: configure MCP server for OpenCode & Antigravity IDE.
  else if (has("--setup-mcp")) {
    try { setupMcp({ dryRun: has("--dry-run") }); process.exit(0); }
    catch (e) { console.error(`agentmap --setup-mcp failed: ${e?.message || e}`); process.exit(3); }
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
      // focusResolved reports the outcome of a REQUESTED --focus only: true when it
      // resolved to a file, false when it matched 0 or 2+ candidates (the silent-
      // degrade case). Left undefined when no --focus was passed, so the JSON key is
      // omitted below — nothing was requested, so there's nothing to report.
      let focusResolved;
      if (focusArg) {
        const { key, candidates } = resolveFile(Object.keys(data.files), data.files, focusArg);
        if (key) { ranked = rankSymbols(data.files, new Set([key])); focusLabel = key; focusResolved = true; }
        else {
          console.error(`# warning: --focus "${focusArg}" matched ${(candidates && candidates.length) || 0} files — using global ranking`);
          focusResolved = false;
          // Reserve exit 1 for "query had zero results": an unresolved --focus is an
          // unresolved query even though the global digest below still prints a
          // useful (degraded) answer — same shape as --find/--feature no-match.
          process.exitCode = 1;
        }
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
            // #6 fix: try progressively fewer symbols DOWN TO ONE. The old
            // `while (partial.length > 1)` sliced before testing and never tried
            // the single-symbol block, so a tiny --tokens could emit NOTHING for
            // the top file despite the "never wholly omitted" intent. If even one
            // symbol overflows the budget, nothing fits (correct) — but we now try.
            for (let k = capped.length - 1; k >= 1; k--) {
              const partial = capped.slice(0, k);
              const pt = tokEst(lineOf(partial));
              if (used + pt <= budget) {
                used += pt;
                shownFiles.push({ file, symbols: partial.map((s) => ({ name: s.name, kind: s.kind })) });
                break;
              }
            }
            first = false;
          }
          continue;
        }
        used += t; first = false;
        shownFiles.push({ file, symbols: capped.map((s) => ({ name: s.name, kind: s.kind })) });
      }
      out({ command: "map", focus: focusLabel, ...(focusResolved !== undefined ? { focusResolved } : {}), budget, tokens: used, files: shownFiles }, () => {
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
}

// ---------------------------------------------------------------------------
// Programmatic API. Importing agentmap.mjs executes NOTHING (see the guard
// below), so these pure building blocks can be used in-process by the MCP
// server, tests, and any future library caller without spawning a subprocess.
// ---------------------------------------------------------------------------
export { pagerank, rankSymbols, identMul, resolveFile, extractVueScripts, stripJsonComments, extractFacts, build, ensureFresh, readPackageVersion, dirtyFiles, dirtyFingerprint, buildDirty, buildIncremental };

// Run the CLI only when executed directly (`node agentmap.mjs …`), never when
// imported. Dual check (matches mcp.mjs) so it holds on Windows (backslash
// argv[1]) and POSIX alike.
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])) {
  await main();
}
