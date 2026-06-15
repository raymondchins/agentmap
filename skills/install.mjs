// SPDX-License-Identifier: MIT
// --install-skill: skill files + always-on docs/hooks per platform (project or global).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWrite,
  readGuidanceSection,
  mergeGuidanceBlock,
  installGeminiHooks,
  installOpencodePlugin,
} from "./install-helpers.mjs";

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = join(SKILLS_DIR, "SKILL.md");
const CURSOR_RULE = join(SKILLS_DIR, "cursor-rule.mdc");

/** @param {string} root @param {boolean} _globalScope */
function skillPath(root, _globalScope, ...segments) {
  return join(root, ...segments);
}

/** @type {Record<string, {
 *   label: string;
 *   src: string;
 *   dest: (root: string, globalScope: boolean) => string;
 *   projectOnly?: boolean;
 *   legacy?: boolean;
 *   docs?: (root: string, globalScope: boolean) => string;
 *   hooks?: boolean;
 *   plugin?: boolean;
 * }>} */
const PLATFORMS = {
  claude: {
    label: "Claude Code",
    src: SKILL_MD,
    dest: (root) => skillPath(root, false, ".claude", "skills", "agentmap", "SKILL.md"),
  },
  cursor: {
    label: "Cursor",
    src: CURSOR_RULE,
    dest: (root) => skillPath(root, false, ".cursor", "rules", "agentmap.mdc"),
    projectOnly: true,
  },
  codex: {
    label: "OpenAI Codex",
    src: SKILL_MD,
    dest: (root) => skillPath(root, false, ".codex", "skills", "agentmap", "SKILL.md"),
    docs: (root, globalScope) =>
      globalScope ? join(root, ".codex", "AGENTS.md") : join(root, "AGENTS.md"),
  },
  opencode: {
    label: "OpenCode",
    src: SKILL_MD,
    dest: (root, globalScope) =>
      globalScope
        ? join(root, ".config", "opencode", "skills", "agentmap", "SKILL.md")
        : join(root, ".opencode", "skills", "agentmap", "SKILL.md"),
    docs: (root, globalScope) =>
      globalScope ? join(root, ".config", "opencode", "AGENTS.md") : join(root, "AGENTS.md"),
    plugin: true,
  },
  gemini: {
    label: "Gemini CLI",
    src: SKILL_MD,
    dest: (root, globalScope) => {
      if (!globalScope) return skillPath(root, false, ".gemini", "skills", "agentmap", "SKILL.md");
      if (osPlatform() === "win32") return skillPath(root, true, ".agents", "skills", "agentmap", "SKILL.md");
      return skillPath(root, true, ".gemini", "skills", "agentmap", "SKILL.md");
    },
    docs: (root, globalScope) => {
      if (!globalScope) return join(root, "GEMINI.md");
      if (osPlatform() === "win32") return join(root, ".agents", "GEMINI.md");
      return join(root, ".gemini", "GEMINI.md");
    },
    hooks: true,
  },
  antigravity: {
    label: "Antigravity",
    src: SKILL_MD,
    dest: (root, globalScope) =>
      globalScope
        ? skillPath(root, true, ".gemini", "config", "skills", "agentmap", "SKILL.md")
        : skillPath(root, false, ".agents", "skills", "agentmap", "SKILL.md"),
  },
  agents: {
    label: "Amp / legacy .agents",
    src: SKILL_MD,
    dest: (root) => skillPath(root, false, ".agents", "skills", "agentmap", "SKILL.md"),
    legacy: true,
  },
  copilot: {
    label: "GitHub Copilot CLI",
    src: SKILL_MD,
    dest: (root) => skillPath(root, false, ".copilot", "skills", "agentmap", "SKILL.md"),
  },
};

const DEFAULT_PLATFORMS = ["claude", "cursor", "codex", "opencode", "gemini", "antigravity", "copilot"];

function parsePlatforms(raw) {
  const keys = Object.keys(PLATFORMS).join(", ");
  if (!raw || raw === "all") return [...DEFAULT_PLATFORMS];
  const tokens = raw.split(/[,+]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (tokens.includes("all")) {
    const extra = tokens.filter((t) => t !== "all");
    for (const n of extra) {
      if (!PLATFORMS[n]) throw new Error(`unknown platform '${n}' — choose: ${keys}, all`);
    }
    return [...new Set([...DEFAULT_PLATFORMS, ...extra])];
  }
  for (const n of tokens) {
    if (!PLATFORMS[n]) {
      throw new Error(`unknown platform '${n}' — choose: ${keys}, all`);
    }
  }
  return tokens;
}

/**
 * Read-only metadata for every install target. Single source of truth for
 * install paths so --doctor doesn't drift from --install-skill. Resolves
 * `root` the same way installSkill() does (homedir when global, else cwd or
 * provided root) and dedupes by dest path so the `agents` legacy alias and
 * `antigravity` project target don't both appear for the same file.
 *
 * @param {{ platforms?: string; project?: boolean; global?: boolean; root?: string }} [opts]
 * @returns {Array<{ name: string; label: string; dest: string; versionPath: string; projectOnly: boolean; legacy: boolean; globalScope: boolean }>}
 */
export function getSkillInstallTargets({ platforms: platformsArg = "all", project = true, global: globalScope = false, root } = {}) {
  const resolvedRoot = root ?? (globalScope ? homedir() : process.cwd());
  const names = parsePlatforms(platformsArg);
  const out = [];
  const seenDest = new Set();
  for (const name of names) {
    const cfg = PLATFORMS[name];
    if (cfg.projectOnly && globalScope) continue;
    const dest = cfg.dest(resolvedRoot, globalScope);
    if (seenDest.has(dest)) continue;
    seenDest.add(dest);
    out.push({
      name,
      label: cfg.label,
      dest,
      versionPath: join(dirname(dest), ".agentmap_version"),
      projectOnly: Boolean(cfg.projectOnly),
      legacy: Boolean(cfg.legacy),
      globalScope,
    });
  }
  return out;
}

function gitAddHint(paths) {
  const unique = [...new Set(paths.map((p) => p.replace(/\/[^/]+$/, "") || p))];
  if (unique.length) console.log(`\nOptional: git add ${unique.map((p) => `"${p}"`).join(" ")}`);
}

function installDocsForPlatform(cfg, { root, globalScope, dryRun, guidance, mergedDocs, targets }) {
  if (!cfg.docs) return;
  const dest = cfg.docs(root, globalScope);
  if (mergedDocs.has(dest)) return;
  mergedDocs.add(dest);
  const title = dest.endsWith("GEMINI.md") ? "agentmap" : undefined;
  if (dryRun) {
    console.log(`  ${cfg.label} docs: ${dest}`);
    return;
  }
  const existing = existsSync(dest) ? readFileSync(dest, "utf8") : "";
  atomicWrite(dest, mergeGuidanceBlock(existing, guidance, title));
  console.log(`  ${cfg.label} docs → ${dest}`);
  targets.push(dest);
}

function installExtrasForPlatform(name, cfg, { root, globalScope, dryRun, targets }) {
  if (cfg.hooks && !globalScope) {
    const hookTargets = installGeminiHooks(root, dryRun);
    for (const t of hookTargets) {
      if (dryRun) console.log(`  ${cfg.label} hooks: ${t}`);
      else {
        console.log(`  ${cfg.label} hooks → ${t}`);
        targets.push(t);
      }
    }
  }
  if (cfg.plugin && !globalScope) {
    const pluginTargets = installOpencodePlugin(root, dryRun);
    for (const t of pluginTargets) {
      if (dryRun) console.log(`  ${cfg.label} plugin: ${t}`);
      else {
        console.log(`  ${cfg.label} plugin → ${t}`);
        targets.push(t);
      }
    }
  }
}

/**
 * @param {{ platforms?: string; project?: boolean; global?: boolean; dryRun?: boolean }} opts
 */
export function installSkill({ platforms: platformsArg = "all", project = true, global: globalScope = false, dryRun = false } = {}) {
  if (project && globalScope) throw new Error("use either --project or --global, not both");
  const VERSION = JSON.parse(readFileSync(join(SKILLS_DIR, "..", "package.json"), "utf8")).version;
  const scope = globalScope ? "global" : "project";
  const root = globalScope ? homedir() : process.cwd();
  const names = parsePlatforms(platformsArg);
  const targets = [];
  const seenDest = new Set();
  const mergedDocs = new Set();
  const guidance = readGuidanceSection();

  if (dryRun) console.log(`--dry-run: would install agentmap skill (${scope} scope):`);

  for (const name of names) {
    const cfg = PLATFORMS[name];
    if (cfg.projectOnly && globalScope) {
      console.log(`  skip ${cfg.label}: Cursor rule is project-scoped only (re-run with --project)`);
      continue;
    }
    if (!existsSync(cfg.src)) throw new Error(`packaged skill missing: ${cfg.src}`);
    const dest = cfg.dest(root, globalScope);
    const skipSkill = seenDest.has(dest);
    if (skipSkill) {
      console.log(`  skip ${cfg.label} skill: same path as another platform (${dest})`);
    } else {
      seenDest.add(dest);
      if (dryRun) {
        console.log(`  ${cfg.label} skill: ${dest}`);
      } else {
        atomicWrite(dest, readFileSync(cfg.src, "utf8"));
        writeFileSync(join(dirname(dest), ".agentmap_version"), VERSION + "\n", "utf8");
        console.log(`  ${cfg.label} skill → ${dest}`);
        targets.push(dest);
      }
    }

    installDocsForPlatform(cfg, { root, globalScope, dryRun, guidance, mergedDocs, targets });
    installExtrasForPlatform(name, cfg, { root, globalScope, dryRun, targets });
  }

  if (!dryRun && targets.length) {
    console.log(`\nagentmap --install-skill: installed ${targets.length} file(s) (${scope}).`);
    if (!globalScope) gitAddHint(targets);
    console.log("Pair with: agentmap --install-hooks (Claude Code) or agentmap --mcp (Cursor MCP).");
  }
}
