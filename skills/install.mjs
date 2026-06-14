// SPDX-License-Identifier: MIT
// --install-skill: copy packaged SKILL.md / Cursor rule into project or global
// agent directories (project or global scope).
// Platform paths aligned with graphify _platform_skill_destination() (v0.8.39).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_MD = join(SKILLS_DIR, "SKILL.md");
const CURSOR_RULE = join(SKILLS_DIR, "cursor-rule.mdc");

/** @param {string} root @param {boolean} globalScope */
function skillPath(root, globalScope, ...segments) {
  return join(root, ...segments);
}

/** @type {Record<string, { label: string; src: string; dest: (root: string, globalScope: boolean) => string; projectOnly?: boolean; legacy?: boolean }>} */
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
  },
  opencode: {
    label: "OpenCode",
    src: SKILL_MD,
    // Project: .opencode/skills/ (repo). Global: ~/.config/opencode/skills/ (not .config in repo).
    dest: (root, globalScope) =>
      globalScope
        ? join(root, ".config", "opencode", "skills", "agentmap", "SKILL.md")
        : join(root, ".opencode", "skills", "agentmap", "SKILL.md"),
  },
  gemini: {
    label: "Gemini CLI",
    src: SKILL_MD,
    dest: (root, globalScope) => {
      if (!globalScope) return skillPath(root, false, ".gemini", "skills", "agentmap", "SKILL.md");
      if (osPlatform() === "win32") return skillPath(root, true, ".agents", "skills", "agentmap", "SKILL.md");
      return skillPath(root, true, ".gemini", "skills", "agentmap", "SKILL.md");
    },
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

/** Default --platform all: Tier B + core; excludes legacy `agents` (use antigravity for graphify-aligned global). */
const DEFAULT_PLATFORMS = ["claude", "cursor", "codex", "opencode", "gemini", "antigravity", "copilot"];

function atomicWrite(dest, body) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, dest);
}

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

function gitAddHint(paths) {
  const unique = [...new Set(paths.map((p) => p.replace(/\/[^/]+$/, "") || p))];
  if (unique.length) console.log(`\nOptional: git add ${unique.map((p) => `"${p}"`).join(" ")}`);
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

  if (dryRun) console.log(`--dry-run: would install agentmap skill (${scope} scope):`);

  for (const name of names) {
    const cfg = PLATFORMS[name];
    if (cfg.projectOnly && globalScope) {
      console.log(`  skip ${cfg.label}: Cursor rule is project-scoped only (re-run with --project)`);
      continue;
    }
    if (!existsSync(cfg.src)) throw new Error(`packaged skill missing: ${cfg.src}`);
    const dest = cfg.dest(root, globalScope);
    if (seenDest.has(dest)) {
      console.log(`  skip ${cfg.label}: same path as another platform (${dest})`);
      continue;
    }
    seenDest.add(dest);
    const body = readFileSync(cfg.src, "utf8");
    const versionFile = join(dirname(dest), ".agentmap_version");

    if (dryRun) {
      console.log(`  ${cfg.label}: ${dest}`);
      continue;
    }

    atomicWrite(dest, body);
    writeFileSync(versionFile, VERSION + "\n", "utf8");
    console.log(`  ${cfg.label} → ${dest}`);
    targets.push(dest);
  }

  if (!dryRun && targets.length) {
    console.log(`\nagentmap --install-skill: installed ${targets.length} file(s) (${scope}).`);
    if (!globalScope) gitAddHint(targets);
    console.log("Pair with: agentmap --install-hooks (Claude Code) or agentmap --mcp (Cursor MCP).");
  }
}
