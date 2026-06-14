// SPDX-License-Identifier: MIT
// --install-docs: merge always-on guidance (GEMINI.md / AGENTS.md) and optional
// hooks/plugins for Gemini CLI and OpenCode. Complements --install-skill.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));
const GUIDANCE = join(SKILLS_DIR, "guidance.md");
const GEMINI_NUDGE_SRC = join(SKILLS_DIR, "..", "hooks", "agentmap-gemini-nudge.mjs");
const OPENCODE_PLUGIN_SRC = join(SKILLS_DIR, "opencode-agentmap-nudge.js");

const MARK_BEGIN = "<!-- agentmap:begin -->";
const MARK_END = "<!-- agentmap:end -->";

/** @type {Record<string, { label: string; docs?: (root: string, globalScope: boolean) => string; hooks?: boolean; plugin?: boolean; projectOnly?: boolean }>} */
const PLATFORMS = {
  gemini: {
    label: "Gemini CLI",
    docs: (root, globalScope) =>
      globalScope ? join(root, ".gemini", "GEMINI.md") : join(root, "GEMINI.md"),
    hooks: true,
  },
  codex: {
    label: "OpenAI Codex",
    docs: (root, globalScope) =>
      globalScope ? join(root, ".codex", "AGENTS.md") : join(root, "AGENTS.md"),
  },
  opencode: {
    label: "OpenCode",
    docs: (root, globalScope) =>
      globalScope ? join(root, ".config", "opencode", "AGENTS.md") : join(root, "AGENTS.md"),
    plugin: true,
  },
};

const DEFAULT_PLATFORMS = ["gemini", "codex", "opencode"];

function atomicWrite(dest, body) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, dest);
}

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

function parseSettings(text, settingsPath) {
  try { return JSON.parse(text) || {}; }
  catch {
    try { return JSON.parse(stripJsonComments(text)) || {}; }
    catch { throw new Error(`${settingsPath} is not valid JSON — fix or remove it, then re-run`); }
  }
}

function mergeGuidanceBlock(existing, section, title) {
  const block = `${MARK_BEGIN}\n${section.trim()}\n${MARK_END}`;
  const re = /<!-- agentmap:begin -->[\s\S]*?<!-- agentmap:end -->/;
  if (existing && re.test(existing)) return existing.replace(re, block);
  const header = title ? `# ${title}\n\n` : "";
  if (!existing?.trim()) return `${header}${block}\n`;
  return `${existing.trimEnd()}\n\n${block}\n`;
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
    if (!PLATFORMS[n]) throw new Error(`unknown platform '${n}' — choose: ${keys}, all`);
  }
  return tokens;
}

function installGeminiHooks(root, dryRun) {
  if (root !== process.cwd()) return []; // hooks are project-scoped only
  const nudgeRel = ".gemini/hooks/agentmap-nudge.mjs";
  const nudgeDest = join(root, nudgeRel);
  const settingsPath = ".gemini/settings.json";
  const NUDGE_CMD = `node "$GEMINI_PROJECT_DIR/.gemini/hooks/agentmap-nudge.mjs"`;
  const targets = [nudgeRel, settingsPath];

  let settings = {};
  if (existsSync(settingsPath)) {
    settings = parseSettings(readFileSync(settingsPath, "utf8"), settingsPath);
  }
  settings.hooks ??= {};
  settings.hooks.BeforeTool ??= [];
  const matcher = "run_shell_command|grep|search";
  const already = settings.hooks.BeforeTool.some(
    (e) => e?.matcher === matcher && Array.isArray(e?.hooks) &&
      e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("agentmap-nudge")),
  );

  if (dryRun) return targets;
  if (!existsSync(GEMINI_NUDGE_SRC)) throw new Error(`packaged hook missing: ${GEMINI_NUDGE_SRC}`);
  mkdirSync(dirname(nudgeDest), { recursive: true });
  writeFileSync(nudgeDest, readFileSync(GEMINI_NUDGE_SRC, "utf8"));

  if (!already) {
    settings.hooks.BeforeTool.push({
      matcher,
      hooks: [{
        name: "agentmap-nudge",
        type: "command",
        command: NUDGE_CMD,
        timeout: 5000,
        description: "Nudge structural searches toward agentmap",
      }],
    });
    atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return targets;
}

function installOpencodePlugin(root, dryRun) {
  if (root !== process.cwd()) return [];
  const dest = ".opencode/plugins/agentmap-nudge.js";
  if (dryRun) return [dest];
  if (!existsSync(OPENCODE_PLUGIN_SRC)) throw new Error(`packaged plugin missing: ${OPENCODE_PLUGIN_SRC}`);
  atomicWrite(join(root, dest), readFileSync(OPENCODE_PLUGIN_SRC, "utf8"));
  return [dest];
}

function gitAddHint(paths) {
  const unique = [...new Set(paths.map((p) => p.replace(/\/[^/]+$/, "") || p))];
  if (unique.length) console.log(`\nOptional: git add ${unique.map((p) => `"${p}"`).join(" ")}`);
}

/**
 * @param {{ platforms?: string; project?: boolean; global?: boolean; dryRun?: boolean }} opts
 */
export function installDocs({ platforms: platformsArg = "all", project = true, global: globalScope = false, dryRun = false } = {}) {
  if (project && globalScope) throw new Error("use either --project or --global, not both");
  if (!existsSync(GUIDANCE)) throw new Error(`packaged guidance missing: ${GUIDANCE}`);
  const section = readFileSync(GUIDANCE, "utf8");
  const scope = globalScope ? "global" : "project";
  const root = globalScope ? homedir() : process.cwd();
  const names = parsePlatforms(platformsArg);
  const targets = [];
  const mergedDocs = new Set();

  if (dryRun) console.log(`--dry-run: would install agentmap docs/hooks (${scope} scope):`);

  for (const name of names) {
    const cfg = PLATFORMS[name];
    if (cfg.projectOnly && globalScope) {
      console.log(`  skip ${cfg.label}: project-scoped only (re-run with --project)`);
      continue;
    }

    if (cfg.docs) {
      const dest = cfg.docs(root, globalScope);
      if (!mergedDocs.has(dest)) {
        mergedDocs.add(dest);
        const title = dest.endsWith("GEMINI.md") ? "agentmap" : undefined;
        const existing = existsSync(dest) ? readFileSync(dest, "utf8") : "";
        const body = mergeGuidanceBlock(existing, section, title);
        if (dryRun) {
          console.log(`  ${cfg.label} docs: ${dest}`);
        } else {
          atomicWrite(dest, body);
          console.log(`  ${cfg.label} docs → ${dest}`);
          targets.push(dest);
        }
      }
    }

    if (cfg.hooks && !globalScope) {
      const hookTargets = installGeminiHooks(root, dryRun);
      if (dryRun) {
        for (const t of hookTargets) console.log(`  Gemini CLI hooks: ${t}`);
      } else {
        for (const t of hookTargets) {
          console.log(`  Gemini CLI hooks → ${t}`);
          targets.push(t);
        }
      }
    }

    if (cfg.plugin && !globalScope) {
      const pluginTargets = installOpencodePlugin(root, dryRun);
      if (dryRun) {
        for (const t of pluginTargets) console.log(`  OpenCode plugin: ${t}`);
      } else {
        for (const t of pluginTargets) {
          console.log(`  OpenCode plugin → ${t}`);
          targets.push(t);
        }
      }
    }
  }

  if (!dryRun && targets.length) {
    console.log(`\nagentmap --install-docs: installed/updated ${targets.length} path(s) (${scope}).`);
    if (!globalScope) gitAddHint(targets);
    console.log("Pair with: agentmap --install-skill (skills) and agentmap --install-hooks (Claude Code).");
  }
}
