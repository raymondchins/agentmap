// SPDX-License-Identifier: MIT
// Shared helpers for --install-skill (docs merge, hooks, plugins).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));
export const GUIDANCE = join(SKILLS_DIR, "guidance.md");
const GEMINI_NUDGE_SRC = join(SKILLS_DIR, "..", "hooks", "agentmap-gemini-nudge.mjs");
const OPENCODE_PLUGIN_SRC = join(SKILLS_DIR, "opencode-agentmap-nudge.js");

export const MARK_BEGIN = "<!-- agentmap:begin -->";
export const MARK_END = "<!-- agentmap:end -->";

export function atomicWrite(dest, body) {
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

export function readGuidanceSection() {
  if (!existsSync(GUIDANCE)) throw new Error(`packaged guidance missing: ${GUIDANCE}`);
  return readFileSync(GUIDANCE, "utf8");
}

export function mergeGuidanceBlock(existing, section, title) {
  const block = `${MARK_BEGIN}\n${section.trim()}\n${MARK_END}`;
  const re = /<!-- agentmap:begin -->[\s\S]*?<!-- agentmap:end -->/;
  if (existing && re.test(existing)) return existing.replace(re, block);
  const header = title ? `# ${title}\n\n` : "";
  if (!existing?.trim()) return `${header}${block}\n`;
  return `${existing.trimEnd()}\n\n${block}\n`;
}

/** @returns {string[]} relative paths touched */
export function installGeminiHooks(root, dryRun) {
  if (root !== process.cwd()) return [];
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

/** @returns {string[]} relative paths touched */
export function installOpencodePlugin(root, dryRun) {
  if (root !== process.cwd()) return [];
  const dest = ".opencode/plugins/agentmap-nudge.js";
  if (dryRun) return [dest];
  if (!existsSync(OPENCODE_PLUGIN_SRC)) throw new Error(`packaged plugin missing: ${OPENCODE_PLUGIN_SRC}`);
  atomicWrite(join(root, dest), readFileSync(OPENCODE_PLUGIN_SRC, "utf8"));
  return [dest];
}
