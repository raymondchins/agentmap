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
//  The behavioural test proves GIT RAN THE HOOK, which a path assertion cannot.
//  It does so with a planted `./agentmap.mjs` stub + AGENTMAP_HOOK_ALLOW_LOCAL=1
//  (hook rung 1) rather than by letting the hook resolve a real agentmap binary:
//  rungs 2-4 need a node_modules install, a PATH binary, or a network npx, none
//  of which a temp fixture has. An earlier cut of this file did rely on that
//  resolution — it passed locally and failed on every CI platform, which is the
//  test being environment-dependent, not the fix being wrong.
//
//  Run: node --test test/worktree-hooks.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeRepo, gitInit, git, run, runErr, cleanup } from "./helpers.mjs";

// Same reasoning as test/post-commit-hook.test.mjs: hooks/post-commit is a POSIX
// sh script. Git for Windows runs it through its own bundled bash, so what is
// missing on win32 is this harness, not the behaviour. The path assertions below
// are platform-independent and run everywhere.
const POSIX_ONLY = { skip: process.platform === "win32" ? "hooks/post-commit is a POSIX sh script; sh is unavailable on win32" : false };

// A stand-in for the real CLI: hook rung 1 runs `node ./agentmap.mjs`, so if this
// marker appears, git executed the hook that --install-hooks wrote.
const PAYLOAD = 'import{writeFileSync}from"node:fs";writeFileSync("HOOK_RAN","x")\n';

// A worktree in its own temp root, so it never collides with the harness's
// sentinel paths in tmpdir().
function addWorktree(main, branch) {
  const dir = join(mkdtempSync(join(tmpdir(), "agentmap-wt-")), "tree");
  git(main, "worktree", "add", "-q", dir, "-b", branch);
  return dir;
}

test("--install-hooks in a worktree writes to the dir git runs hooks from", () => {
  const main = makeRepo({ "src/a.ts": "export const a = 1;\n" });
  try {
    gitInit(main, { commit: true });
    const tree = addWorktree(main, "feat");
    try {
      run(tree, "--install-hooks");
      // Before the fix this file was absent and an orphan sat under
      // .git/worktrees/<name>/hooks, which git never reads.
      assert.ok(
        existsSync(join(main, ".git", "hooks", "post-commit")),
        "post-commit must land in the common dir, not the per-worktree git dir",
      );
    } finally {
      git(main, "worktree", "remove", "--force", tree);
    }
  } finally { cleanup(main); }
});

test("git really runs that hook on a commit inside the worktree", POSIX_ONLY, () => {
  const main = makeRepo({ "src/a.ts": "export const a = 1;\n" });
  try {
    gitInit(main, { commit: true });
    // gitInit points core.hooksPath at a nonexistent dir so stray hooks never
    // fire; this test is specifically about the hook firing.
    git(main, "config", "--unset", "core.hooksPath");
    const tree = addWorktree(main, "feat-run");
    try {
      run(tree, "--install-hooks");
      writeFileSync(join(tree, "agentmap.mjs"), PAYLOAD);
      writeFileSync(join(tree, "src", "b.ts"), "export const b = 2;\n");
      git(tree, "add", "-A");
      // The hook inherits the committing process's env, which is how rung 1 gets
      // opted into. It backgrounds its work, so wait before asserting.
      execFileSync("git", ["commit", "-qm", "second"], {
        cwd: tree, env: { ...process.env, AGENTMAP_HOOK_ALLOW_LOCAL: "1" }, stdio: "ignore",
      });
      execFileSync("sh", ["-c", "sleep 2"]);
      assert.ok(
        existsSync(join(tree, "HOOK_RAN")),
        "git did not run the installed hook — auto-refresh is dead inside the worktree",
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
    assert.match(runErr(main, "--install-hooks").stderr, /core\.hooksPath/,
      "install must warn that the hook is inert");

    const doctor = run(main, "--doctor").stdout;
    const line = doctor.split("\n").find((l) => l.includes("post-commit"));
    assert.match(line, /INERT/, `expected an inert report, got: ${line}`);
    assert.match(doctor, /overall: needs attention/);
  } finally { cleanup(main); }
});
