// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

test("--hook-status reports not installed before --install-hooks", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
    "src/index.ts": "export function x() { return 1; }",
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--hook-status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /post-commit: not installed/);
  assert.match(r.stdout, /nudge.*not installed/);
  cleanup(dir);
});

test("--hook-status reports installed after --install-hooks", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
    "src/index.ts": "export function x() { return 1; }",
  });
  gitInit(dir, { commit: true });
  assert.equal(run(dir, "--install-hooks").status, 0);
  const r = run(dir, "--hook-status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /post-commit: installed/);
  assert.match(r.stdout, /nudge.*installed/);
  assert.match(r.stdout, /PreToolUse\(Grep\): wired/);
  assert.match(r.stdout, /PreToolUse\(Bash\): wired/);
  assert.match(r.stdout, /\.gitignore.*ok/);
  cleanup(dir);
});

test("--hook-status detects foreign post-commit without agentmap marker", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
    "src/index.ts": "export function x() { return 1; }",
  });
  gitInit(dir, { commit: true });
  const hookPath = join(dir, ".git", "hooks", "post-commit");
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  writeFileSync(hookPath, "#!/bin/sh\necho other hook\n", { mode: 0o755 });
  const r = run(dir, "--hook-status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /post-commit: not installed \(hook exists but agentmap not found\)/);
  cleanup(dir);
});
