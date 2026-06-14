// SPDX-License-Identifier: MIT
// --install-skill: copy packaged SKILL.md / Cursor rule into project or global
// agent directories (project or global scope).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(SKILLS_DIR, "..", "package.json"), "utf8")).version;

/** @type {Record<string, { label: string; src: string; dest: (root: string) => string; projectOnly?: boolean }>} */
const PLATFORMS = {
  claude: {
    label: "Claude Code",
    src: join(SKILLS_DIR, "SKILL.md"),
    dest: (root) => join(root, ".claude", "skills", "agentmap", "SKILL.md"),
  },
  agents: {
    label: "Codex / OpenCode (.agents)",
    src: join(SKILLS_DIR, "SKILL.md"),
    dest: (root) => join(root, ".agents", "skills", "agentmap", "SKILL.md"),
  },
  cursor: {
    label: "Cursor",
    src: join(SKILLS_DIR, "cursor-rule.mdc"),
    dest: (root) => join(root, ".cursor", "rules", "agentmap.mdc"),
    projectOnly: true,
  },
};

function atomicWrite(dest, body) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, dest);
}

function parsePlatforms(raw) {
  if (!raw || raw === "all") return ["claude", "cursor", "agents"];
  const names = raw.split(/[,+]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const n of names) {
    if (!PLATFORMS[n]) {
      throw new Error(`unknown platform '${n}' — choose: ${Object.keys(PLATFORMS).join(", ")}, all`);
    }
  }
  return names;
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
  const scope = globalScope ? "global" : "project";
  const root = globalScope ? homedir() : process.cwd();
  const names = parsePlatforms(platformsArg);
  const targets = [];

  if (dryRun) console.log(`--dry-run: would install agentmap skill (${scope} scope):`);

  for (const name of names) {
    const cfg = PLATFORMS[name];
    if (cfg.projectOnly && globalScope) {
      console.log(`  skip ${cfg.label}: Cursor rule is project-scoped only (re-run with --project)`);
      continue;
    }
    if (!existsSync(cfg.src)) throw new Error(`packaged skill missing: ${cfg.src}`);
    const dest = cfg.dest(root);
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
