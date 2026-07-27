// SPDX-License-Identifier: MIT
// Security regression tests for hooks/post-commit. The hook must NEVER execute
// a working-tree ./agentmap.mjs by default (attacker-plantable → arbitrary code
// execution on the victim's next commit); it runs only with an explicit
// AGENTMAP_HOOK_ALLOW_LOCAL=1 opt-in meant for developing agentmap itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, chmodSync, mkdirSync, utimesSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, writeFiles, gitInit, cleanup } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SRC = join(HERE, "..", "hooks", "post-commit");

// hooks/post-commit is a POSIX /bin/sh script, and every test below drives it by
// spawning `sh` directly. `sh` is not a Windows platform binary — git for Windows
// ships its own bash and runs the hook through that, so what is unavailable on
// win32 is this harness, not the hook. Skipped explicitly rather than left to fail
// or, worse, rewritten into something that passes without executing anything.
const POSIX_ONLY = { skip: process.platform === "win32" ? "hooks/post-commit is a POSIX sh script; sh is unavailable on win32" : false };

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

test("planted ./agentmap.mjs is NOT executed by the post-commit hook by default", POSIX_ONLY, () => {
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

test("AGENTMAP_HOOK_ALLOW_LOCAL=1 opts in to running ./agentmap.mjs", POSIX_ONLY, () => {
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

test("a held lock makes the hook skip instead of piling on", POSIX_ONLY, () => {
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

test("a lock older than 10 minutes is cleared so refresh cannot stay dead", POSIX_ONLY, () => {
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

// ─── Timeout kills the whole process group ────────────────────────────────────
//
// The timeout must reach GRANDCHILDREN, not just the pid the hook backgrounded.
// Runner fallback #4 is `npx --no-install @raymondchins/agentmap`, where the
// backgrounded pid is the npx wrapper and the real work is a child `node
// .../bin/agentmap`. Signalling only the wrapper leaves that child reparented to
// init, still spinning: observed in the wild as `npm exec @raymondchins/agentmap`
// (pid 5361) whose child (pid 7386) outlived it at ~30 W, three at once drawing
// 114.5 W with the battery dropping 2%/min.
//
// This asserts on a heartbeat file going stale rather than on process tables,
// which are awkward to inspect portably. A surviving grandchild keeps writing.

// Stands in for the npx wrapper: spawns a heartbeat-writing child in the SAME
// process group (npx does not detach), then hangs so the watchdog has to fire.
const WRAPPER = [
  'import{spawn}from"node:child_process";',
  'spawn(process.execPath,["-e",',
  '  "setInterval(()=>require(\'fs\').writeFileSync(\'HEARTBEAT\',String(Date.now())),100)"',
  '],{stdio:"ignore"});',
  'setInterval(()=>{},1000);\n',
].join("");

test("the timeout reaps a hung runner's grandchild, not just the wrapper", POSIX_ONLY, () => {
  const dir = makeRepo({ "agentmap.mjs": WRAPPER, "a.ts": "export const a = 1;\n" });
  const beat = join(dir, "HEARTBEAT");
  try {
    gitInit(dir);
    installHook(dir);
    execFileSync("sh", [join(dir, ".git", "hooks", "post-commit")], {
      cwd: dir,
      env: { ...process.env, AGENTMAP_HOOK_ALLOW_LOCAL: "1", AGENTMAP_HOOK_TIMEOUT: "2" },
      stdio: "ignore",
    });
    // 2s timeout + 5s SIGTERM→SIGKILL grace + slack.
    execFileSync("sh", ["-c", "sleep 9"]);
    assert.ok(existsSync(beat), "grandchild never started — test is not exercising the kill path");
    const first = readFileSync(beat, "utf8");
    execFileSync("sh", ["-c", "sleep 2"]);
    assert.equal(readFileSync(beat, "utf8"), first,
      "grandchild outlived the watchdog — the timeout killed only the wrapper pid, so an orphan is left spinning a full core");
  } finally {
    // Never let a failing assertion leak the very process this test is about.
    try {
      execFileSync("pkill", ["-f", "HEARTBEAT"], { stdio: "ignore" });
    } catch { /* nothing matched — already reaped */ }
    cleanup(dir);
  }
});
