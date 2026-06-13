// SPDX-License-Identifier: MIT
// --install-hooks: copies hooks/post-commit into .git/hooks (chmod 0755),
// ensures .gitignore contains .claude/agentmap.json, prints the Claude Code
// PreToolUse settings snippet, exits 0 on success.
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
  assert.ok((mode & 0o111) !== 0, `post-commit hook not executable (mode ${mode.toString(8)})`);

  // .gitignore now ignores the generated map.
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.match(gi, /\.claude\/agentmap\.json/, ".gitignore missing agentmap.json entry");

  // Prints the PreToolUse settings snippet referencing the nudge hook.
  assert.match(r.stdout, /PreToolUse|settings\.json|agentmap-nudge/i, "expected settings snippet in output");
  cleanup(dir);
});

test("--install-hooks does not duplicate the .gitignore entry on re-run", () => {
  const dir = makeRepo({
    ".gitignore": "node_modules/\n.claude/agentmap.json\n",
    "src/index.ts": `export function x() { return 1; }`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--install-hooks");
  assert.equal(r.status, 0, r.stderr);
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  const occurrences = (gi.match(/\.claude\/agentmap\.json/g) || []).length;
  assert.equal(occurrences, 1, `expected exactly one .gitignore entry, found ${occurrences}`);
  cleanup(dir);
});
