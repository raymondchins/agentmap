// SPDX-License-Identifier: MIT
// ============================================================================
//  --install-hooks inside a linked git worktree, and the core.hooksPath redirect.
//
//  `git rev-parse --git-dir` in a worktree returns <main>/.git/worktrees/<name>,
//  but git executes hooks from the COMMON dir (<main>/.git/hooks). Installing
//  against --git-dir therefore wrote a hook git never runs, while --install-hooks
//  printed "Done — the map auto-refreshes on commit" and --doctor reported
//  "installed". The freshness promise — the one guarantee this tool is built
//  around — died silently, in the exact install shape a parallel-agent workflow
//  uses most.
//
//  The first test asserts BEHAVIOUR (a real commit moves generatedSha), not the
//  hook file's existence: a file in the right place that never fires would pass a
//  path assertion and still be the same bug. That means it must undo the harness's
//  own core.hooksPath=<nonexistent> (gitInit sets it so stray hooks never run),
//  the same way test/post-commit-hook.test.mjs does.
//
//  Run: node --test test/worktree-hooks.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeRepo, gitInit, git, run, runErr, cleanup } from "./helpers.mjs";

// Wait for the detached post-commit rebuild to land. The hook runs in the
// background on purpose, so polling is the honest way to observe it.
function waitForSha(mapPath, before, tries = 60) {
  const block = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < tries; i++) {
    try {
      const sha = JSON.parse(readFileSync(mapPath, "utf8")).generatedSha;
      if (sha && sha !== before) return sha;
    } catch { /* not written yet, or caught mid-rename */ }
    Atomics.wait(block, 0, 0, 250);
  }
  return before;
}

// A worktree checked out beside the repo, in its own temp root so it never
// collides with the harness's sentinel paths in tmpdir().
function addWorktree(main, branch) {
  const dir = join(mkdtempSync(join(tmpdir(), "agentmap-wt-")), "tree");
  git(main, "worktree", "add", "-q", dir, "-b", branch);
  return dir;
}

test("--install-hooks in a worktree wires the hook git actually runs", () => {
  const main = makeRepo({ "src/a.ts": "export const a = 1;\n" });
  try {
    gitInit(main, { commit: true });
    // gitInit points core.hooksPath at a nonexistent dir so stray hooks never
    // fire; this test is specifically about the hook firing.
    git(main, "config", "--unset", "core.hooksPath");
    const tree = addWorktree(main, "feat");
    try {
      run(tree, "--install-hooks");

      // The common dir is where git looks. Before the fix this file was absent,
      // and an orphan sat under .git/worktrees/<name>/hooks instead.
      assert.ok(
        existsSync(join(main, ".git", "hooks", "post-commit")),
        "post-commit must land in the common dir, not the per-worktree git dir",
      );

      // Commit what --install-hooks just created (.gitignore, .claude/hooks/…),
      // otherwise the tree is dirty and agentmap correctly writes map.dirty.json
      // instead of map.json — the freshness invariant doing its job.
      git(tree, "add", "-A");
      git(tree, "commit", "-qm", "wire agentmap");

      // Behavioural proof: a real commit inside the worktree rebuilds the map.
      run(tree, "--hubs");
      const mapPath = join(tree, ".claude", "agentmap", "map.json");
      const before = JSON.parse(readFileSync(mapPath, "utf8")).generatedSha;
      writeFileSync(join(tree, "src", "b.ts"), "export const b = 2;\n");
      git(tree, "add", "-A");
      git(tree, "commit", "-qm", "second");
      assert.notEqual(
        waitForSha(mapPath, before), before,
        "post-commit did not refresh the map inside the worktree",
      );
    } finally {
      git(main, "worktree", "remove", "--force", tree);
    }
  } finally { cleanup(main); }
});

test("--doctor reports the hook path git resolves, not the per-worktree one", () => {
  const main = makeRepo({ "src/a.ts": "export const a = 1;\n" });
  try {
    gitInit(main, { commit: true });
    git(main, "config", "--unset", "core.hooksPath");
    const tree = addWorktree(main, "feat-d");
    try {
      run(tree, "--install-hooks");
      const line = run(tree, "--doctor").stdout.split("\n").find((l) => l.includes("post-commit"));
      assert.ok(line, "doctor should report a post-commit row");
      assert.match(line, /installed/);
      assert.ok(
        !line.includes("worktrees"),
        `doctor pointed at the per-worktree git dir, which git never runs hooks from: ${line}`,
      );
    } finally {
      git(main, "worktree", "remove", "--force", tree);
    }
  } finally { cleanup(main); }
});

test("a core.hooksPath redirect is reported as INERT, not installed", () => {
  // husky sets core.hooksPath=.husky. The hook is written correctly and git never
  // reads it — the same silent freshness death, so --doctor must not say "ok".
  const main = makeRepo({ "src/a.ts": "export const a = 1;\n" });
  try {
    gitInit(main, { commit: true });
    git(main, "config", "core.hooksPath", ".husky");
    // runErr, not run: run() drops stderr on a zero exit, and the warning is the
    // whole point — installing still succeeds, it just cannot take effect.
    const r = runErr(main, "--install-hooks");
    assert.match(r.stderr, /core\.hooksPath/, "install must warn that the hook is inert");

    const doctor = run(main, "--doctor").stdout;
    const line = doctor.split("\n").find((l) => l.includes("post-commit"));
    assert.match(line, /INERT/, `expected an inert report, got: ${line}`);
    assert.match(doctor, /overall: needs attention/);
  } finally { cleanup(main); }
});
