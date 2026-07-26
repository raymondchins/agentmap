// SPDX-License-Identifier: MIT
// Security regression tests for hooks/post-commit. The hook must NEVER execute
// a working-tree ./agentmap.mjs by default (attacker-plantable → arbitrary code
// execution on the victim's next commit); it runs only with an explicit
// AGENTMAP_HOOK_ALLOW_LOCAL=1 opt-in meant for developing agentmap itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, chmodSync, mkdirSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, writeFiles, gitInit, cleanup } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = join(HERE, "..", "hooks", "post-commit");

// Install the real hook into dir/.git/hooks/post-commit, overriding the
// core.hooksPath=/dev/null that gitInit sets so the hook actually fires.
function installHook(dir) {
  const dest = join(dir, ".git", "hooks", "post-commit");
  copyFileSync(HOOK_SRC, dest);
  chmodSync(dest, 0o755);
  execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd: dir, stdio: "ignore" });
}

// A payload that, if executed by the hook, writes a marker file. Written as ESM
// (the hook runs it via `node ./agentmap.mjs`, which treats .mjs as a module).
const PAYLOAD = 'import{writeFileSync}from"node:fs";writeFileSync("PWNED","x")\n';

test("planted ./agentmap.mjs is NOT executed by the post-commit hook by default", () => {
  const dir = makeRepo({ "agentmap.mjs": PAYLOAD, "a.ts": "export const a = 1;\n" });
  gitInit(dir);
  installHook(dir);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  // The hook fires synchronously enough to spawn its detached child; give the
  // background job a moment, then assert the payload never ran.
  execFileSync("git", ["commit", "-q", "-m", "attack"], { cwd: dir, stdio: "ignore" });
  execFileSync("sh", ["-c", "sleep 1"]);
  assert.equal(existsSync(join(dir, "PWNED")), false,
    "post-commit hook executed a working-tree ./agentmap.mjs without opt-in (RCE)");
  cleanup(dir);
});

test("AGENTMAP_HOOK_ALLOW_LOCAL=1 opts in to running ./agentmap.mjs", () => {
  const dir = makeRepo({ "agentmap.mjs": PAYLOAD, "a.ts": "export const a = 1;\n" });
  gitInit(dir);
  installHook(dir);
  // Invoke the hook directly with the opt-in set (a real commit's env is harder
  // to control cross-platform); the runner backgrounds, so wait then assert.
  execFileSync("sh", [join(dir, ".git", "hooks", "post-commit")], {
    cwd: dir, env: { ...process.env, AGENTMAP_HOOK_ALLOW_LOCAL: "1" }, stdio: "ignore",
  });
  execFileSync("sh", ["-c", "sleep 1"]);
  assert.equal(existsSync(join(dir, "PWNED")), true,
    "AGENTMAP_HOOK_ALLOW_LOCAL=1 did not run the repo-local ./agentmap.mjs");
  cleanup(dir);
});

// ─── Single-instance lock ─────────────────────────────────────────────────────
//
// The rebuild is backgrounded and outlives the commit shell, so a run that hangs
// is reparented to init with nothing left to reap it — observed burning a full
// core for 21 minutes, with a fresh orphan stacking on every later commit. The
// lock is what stops the stacking; the timeout is what stops the burn.
//
// Both tests drive the marker payload rather than a real rebuild, so they assert
// on a file existing, not on timing.

const runHook = (dir) => execFileSync("sh", [join(dir, ".git", "hooks", "post-commit")], {
  cwd: dir, env: { ...process.env, AGENTMAP_HOOK_ALLOW_LOCAL: "1" }, stdio: "ignore",
});

test("a held lock makes the hook skip instead of piling on", () => {
  const dir = makeRepo({ "agentmap.mjs": PAYLOAD, "a.ts": "export const a = 1;\n" });
  gitInit(dir);
  installHook(dir);
  mkdirSync(join(dir, ".git", "agentmap.lock"));
  runHook(dir);
  execFileSync("sh", ["-c", "sleep 1"]);
  assert.equal(existsSync(join(dir, "PWNED")), false,
    "hook ran a second rebuild while one was already in flight — this is the orphan pile-up");
  cleanup(dir);
});

test("a lock older than 10 minutes is cleared so refresh cannot stay dead", () => {
  // Without this, one killed rebuild would disable auto-refresh permanently —
  // a worse failure than the leak it guards against, and a silent one.
  const dir = makeRepo({ "agentmap.mjs": PAYLOAD, "a.ts": "export const a = 1;\n" });
  gitInit(dir);
  installHook(dir);
  const lock = join(dir, ".git", "agentmap.lock");
  mkdirSync(lock);
  const stale = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(lock, stale, stale);
  runHook(dir);
  execFileSync("sh", ["-c", "sleep 1"]);
  assert.equal(existsSync(join(dir, "PWNED")), true,
    "a stale lock permanently blocked the rebuild");
  assert.equal(existsSync(lock), false, "lock not released after the run");
  cleanup(dir);
});
