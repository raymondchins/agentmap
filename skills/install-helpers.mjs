// SPDX-License-Identifier: MIT
// Shared helpers for --install-skill (docs merge, hooks, plugins).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));
export const GUIDANCE = join(SKILLS_DIR, "guidance.md");
const GEMINI_NUDGE_SRC = join(SKILLS_DIR, "..", "hooks", "agentmap-gemini-nudge.mjs");
const CODEX_NUDGE_SRC = join(SKILLS_DIR, "..", "hooks", "agentmap-codex-nudge.mjs");
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

// Parse a settings file that may be JSONC. Returns { settings, hadComments } —
// `hadComments` is true when the file only parsed after comments were stripped,
// which is the caller's cue to warn: we re-serialise with JSON.stringify, so
// every comment in the user's file is dropped on write. Preserving them would
// mean a real JSONC-aware splice; warning is the honest cheap option, and it
// beats the previous behaviour of deleting a user's annotations in silence.
function parseSettings(text, settingsPath) {
  try { return { settings: JSON.parse(text) || {}, hadComments: false }; }
  catch {
    try { return { settings: JSON.parse(stripJsonComments(text)) || {}, hadComments: /\/\/|\/\*/.test(text) }; }
    catch { throw new Error(`${settingsPath} is not valid JSON — fix or remove it, then re-run`); }
  }
}

// Fetch settings.hooks[event] as an array, creating it when absent and REJECTING
// a conflicting shape with a message that names the file and the key.
//
// `settings.hooks ??= {}` only fills null/undefined, so a settings.json where
// `hooks` is a string, a number or an array sailed through and blew up two lines
// later on `.some is not a function` — an opaque TypeError, thrown mid-install
// after earlier platforms had already been written to disk. The user saw a stack
// trace and a half-installed skill, with nothing pointing at the actual cause.
function hookArray(settings, event, settingsPath) {
  if (settings.hooks === undefined || settings.hooks === null) settings.hooks = {};
  if (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error(`${settingsPath}: "hooks" must be an object, found ${Array.isArray(settings.hooks) ? "an array" : typeof settings.hooks} — fix it, then re-run`);
  }
  if (settings.hooks[event] === undefined || settings.hooks[event] === null) settings.hooks[event] = [];
  if (!Array.isArray(settings.hooks[event])) {
    throw new Error(`${settingsPath}: "hooks.${event}" must be an array, found ${typeof settings.hooks[event]} — fix it, then re-run`);
  }
  return settings.hooks[event];
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

  let settings = {}, hadComments = false;
  if (existsSync(settingsPath)) {
    ({ settings, hadComments } = parseSettings(readFileSync(settingsPath, "utf8"), settingsPath));
  }
  // Validates shape and throws a named error before anything is written. Runs on
  // the dry-run path too, on purpose: installSkill() preflights every platform
  // with dryRun=true so a broken settings.json fails before the FIRST file lands,
  // instead of halfway through a multi-platform install.
  const beforeTool = hookArray(settings, "BeforeTool", settingsPath);
  const matcher = "run_shell_command|grep|search";
  const already = beforeTool.some(
    (e) => e?.matcher === matcher && Array.isArray(e?.hooks) &&
      e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("agentmap-nudge")),
  );

  if (dryRun) return targets;
  if (!existsSync(GEMINI_NUDGE_SRC)) throw new Error(`packaged hook missing: ${GEMINI_NUDGE_SRC}`);
  mkdirSync(dirname(nudgeDest), { recursive: true });
  writeFileSync(nudgeDest, readFileSync(GEMINI_NUDGE_SRC, "utf8"));

  if (!already) {
    beforeTool.push({
      matcher,
      hooks: [{
        name: "agentmap-nudge",
        type: "command",
        command: NUDGE_CMD,
        timeout: 5000,
        description: "Nudge structural searches toward agentmap",
      }],
    });
    // Say so before the rewrite, not after. JSON.stringify cannot round-trip
    // JSONC, so the user's comments are about to be gone and the only kind thing
    // to do is name the file they should check.
    if (hadComments) {
      console.warn(`  ⚠ ${settingsPath} contained comments — JSON has no way to keep them, so they were dropped when agentmap added its hook. Re-add them if you need them.`);
    }
    atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return targets;
}

/**
 * Codex CLI PreToolUse gate. Writes the hook script into .codex/hooks/ and
 * registers it in .codex/config.toml via an inline [[hooks.PreToolUse]] table,
 * plus sets `[features] hooks = true` (off by default — hooks are silent
 * without it). Project-scope only (root === cwd). Idempotent: re-running does
 * not duplicate the PreToolUse block or the features flag. We APPEND a fenced
 * agentmap block to config.toml rather than parse/serialize TOML (no dep, and
 * TOML supports repeated [[hooks.PreToolUse]] array-of-tables so appending is
 * valid even if the user already has other PreToolUse hooks).
 *
 * NOTE: `[features] hooks = true` is appended only if no `hooks =` under
 * [features] already exists; if the user has `[features]` with other keys we
 * still append our own minimal `[features]\nhooks = true` fenced block — TOML
 * merges duplicate top-level tables key-by-key, and a later `hooks = true`
 * wins, which is the intent (enable). If they explicitly set `hooks = false`
 * we do NOT flip it (respect an intentional opt-out) — we warn instead.
 *
 * @returns {string[]} relative paths touched
 */
export function installCodexHooks(root, dryRun) {
  if (root !== process.cwd()) return [];
  const hookRel = ".codex/hooks/agentmap-codex-nudge.mjs";
  const hookDest = join(root, hookRel);
  const configRel = ".codex/config.toml";
  const configDest = join(root, configRel);
  const targets = [hookRel, configRel];

  const CODEX_BEGIN = "# agentmap:begin";
  const CODEX_END = "# agentmap:end";
  // $CODEX_PROJECT_DIR is Codex's project-root env var (parallels
  // $GEMINI_PROJECT_DIR); falls back cleanly since config.toml is loaded from
  // the project .codex/ layer.
  const HOOK_CMD =
    'node "$CODEX_PROJECT_DIR/.codex/hooks/agentmap-codex-nudge.mjs"';
  const block =
    `${CODEX_BEGIN}\n` +
    `[features]\n` +
    `hooks = true\n\n` +
    `[[hooks.PreToolUse]]\n` +
    `matcher = "^Bash$"\n\n` +
    `[[hooks.PreToolUse.hooks]]\n` +
    `type = "command"\n` +
    `command = '${HOOK_CMD}'\n` +
    `timeout = 5000\n` +
    `statusMessage = "agentmap: checking search command"\n` +
    `${CODEX_END}\n`;

  if (dryRun) return targets;
  if (!existsSync(CODEX_NUDGE_SRC)) throw new Error(`packaged hook missing: ${CODEX_NUDGE_SRC}`);
  mkdirSync(dirname(hookDest), { recursive: true });
  writeFileSync(hookDest, readFileSync(CODEX_NUDGE_SRC, "utf8"));

  const existing = existsSync(configDest) ? readFileSync(configDest, "utf8") : "";
  const re = /# agentmap:begin[\s\S]*?# agentmap:end/;
  let next;
  if (re.test(existing)) {
    next = existing.replace(re, block.trimEnd());
  } else if (!existing.trim()) {
    next = block;
  } else {
    next = `${existing.trimEnd()}\n\n${block}`;
  }
  if (/\[features\][\s\S]*?hooks\s*=\s*false/.test(existing)) {
    console.log("  WARN Codex hooks: [features] hooks = false is set in .codex/config.toml — leaving it; the agentmap gate stays inactive until you enable hooks.");
  }
  atomicWrite(configDest, next);
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
