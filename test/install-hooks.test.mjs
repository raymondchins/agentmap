// SPDX-License-Identifier: MIT
// --install-hooks: copies hooks/post-commit into .git/hooks (chmod 0755),
// ensures .gitignore contains .claude/agentmap/, auto-wires the Claude Code
// PreToolUse(Grep) and PreToolUse(Bash) nudge hooks into .claude/settings.json
// (merge-safe + idempotent), exits 0 on success.
//
// Both matchers point at the same agentmap-nudge.mjs file — the hook dispatches
// internally on tool_name so a single file covers both the Grep tool and raw
// Bash text-searchers (grep/rg/ag/ack).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

test("--install-hooks installs post-commit, updates .gitignore, prints snippet, exits 0", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
    "src/index.ts": `export function x() { return 1; }`,
  });
  gitInit(dir, { commit: true });

  const r = run(dir, "--install-hooks");
  assert.equal(r.status, 0, `--install-hooks failed (status ${r.status}): ${r.stderr}`);

  // post-commit hook copied into .git/hooks and executable.
  const hookPath = join(dir, ".git", "hooks", "post-commit");
  assert.ok(existsSync(hookPath), "post-commit hook not installed");
  const mode = statSync(hookPath).mode & 0o777;
  if (process.platform !== "win32") {
    assert.ok((mode & 0o111) !== 0, `post-commit hook not executable (mode ${mode.toString(8)})`);
  }

  // .gitignore now ignores the generated map (namespaced dir).
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.match(gi, /\.claude\/agentmap\//, ".gitignore missing agentmap/ entry");

  // Reports wiring the PreToolUse nudge.
  assert.match(r.stdout, /PreToolUse|settings\.json|agentmap/i, "expected settings wiring in output");

  // Auto-wires both PreToolUse(Grep) and PreToolUse(Bash) nudges into project
  // .claude/settings.json (both point at the same agentmap-nudge.mjs file).
  const sp = join(dir, ".claude", "settings.json");
  assert.ok(existsSync(sp), ".claude/settings.json not written");
  const s = JSON.parse(readFileSync(sp, "utf8"));
  const grepHook = (s.hooks?.PreToolUse || []).find((e) => e.matcher === "Grep");
  assert.ok(grepHook, "no PreToolUse(Grep) entry wired");
  assert.match(grepHook.hooks[0].command, /agentmap-nudge\.mjs/, "Grep hook does not point at agentmap-nudge");
  const bashHook = (s.hooks?.PreToolUse || []).find((e) => e.matcher === "Bash");
  assert.ok(bashHook, "no PreToolUse(Bash) entry wired");
  assert.match(bashHook.hooks[0].command, /agentmap-nudge\.mjs/, "Bash hook does not point at agentmap-nudge");
  cleanup(dir);
});

test("--install-hooks merges into existing settings.json + is idempotent", () => {
  const dir = makeRepo({
    ".claude/settings.json": JSON.stringify({
      permissions: { deny: ["Bash(rm -rf *)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
    }, null, 2),
    "src/index.ts": `export function x() { return 1; }`,
  });
  gitInit(dir, { commit: true });

  assert.equal(run(dir, "--install-hooks").status, 0);
  assert.equal(run(dir, "--install-hooks").status, 0); // re-run must not duplicate

  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  // existing keys preserved
  assert.deepEqual(s.permissions.deny, ["Bash(rm -rf *)"], "existing permissions clobbered");
  assert.ok(s.hooks.PreToolUse.some((e) => e.matcher === "Bash"), "existing Bash hook clobbered");
  // our Grep nudge and Bash nudge each added exactly once across two runs
  const nudgeEntries = s.hooks.PreToolUse.filter(
    (e) => Array.isArray(e.hooks) && e.hooks.some((h) => /agentmap-nudge/.test(h.command || "")),
  );
  assert.equal(nudgeEntries.length, 2, `expected exactly two agentmap-nudge entries (Grep + Bash), found ${nudgeEntries.length}`);
  assert.ok(nudgeEntries.some((e) => e.matcher === "Grep"), "missing Grep matcher in nudge entries");
  assert.ok(nudgeEntries.some((e) => e.matcher === "Bash"), "missing Bash matcher in nudge entries");
  cleanup(dir);
});

test("--install-hooks does not duplicate the .gitignore entry on re-run", () => {
  const dir = makeRepo({
    ".gitignore": "node_modules/\n.claude/agentmap/\n",
    "src/index.ts": `export function x() { return 1; }`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--install-hooks");
  assert.equal(r.status, 0, r.stderr);
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  // exact-line match so '.claude/agentmap/' isn't double-counted by a substring
  // of some other line.
  const occurrences = gi.split(/\r?\n/).filter((l) => l.trim() === ".claude/agentmap/").length;
  assert.equal(occurrences, 1, `expected exactly one .gitignore entry, found ${occurrences}`);
  cleanup(dir);
});
