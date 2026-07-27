// SPDX-License-Identifier: MIT
// ============================================================================
//  Black-box test harness for agentmap. Every test drives the REAL CLI as a
//  subprocess against a throwaway repo in os.tmpdir() — zero new deps (only
//  node: builtins), matching the project's dependency-free ethos. We never
//  import agentmap.mjs; we exercise it exactly as a user would.
// ============================================================================
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

// Resolve the repo-root agentmap.mjs relative to THIS file (test/helpers.mjs),
// so the suite is location-independent (CI, local, npx all resolve the same).
const HERE = dirname(fileURLToPath(import.meta.url));
export const AGENTMAP = join(HERE, "..", "agentmap.mjs");

// Create an isolated temp repo. `files` = { "rel/path.ts": "contents" }.
// Returns the absolute repo dir. Caller cleans up via cleanup(dir) (registered
// for auto-removal on process exit as a backstop).
const _dirs = [];
export function makeRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentmap-test-"));
  _dirs.push(dir);
  writeFiles(dir, files);
  return dir;
}

// Write/overwrite a batch of files (creating parent dirs). Used both at repo
// creation and to mutate a repo mid-test (e.g. add a file in a new dir).
export function writeFiles(dir, files = {}) {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

// `git init` + initial config + (optionally) an initial commit of everything.
// Quiet, deterministic identity, no signing/hooks so CI never prompts.
export function gitInit(dir, { commit = false, message = "init" } = {}) {
  const g = (...a) => git(dir, ...a);
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "agentmap-test");
  g("config", "commit.gpgsign", "false");
  // Point hooks at a directory that does not exist — git then finds no hooks, which
  // is the intent. Was "/dev/null"; that happens to work on Windows too (git looks
  // for a \dev\null directory and finds nothing) but only by accident, and reusing
  // the same sentinel as the config vars above says what is meant.
  g("config", "core.hooksPath", NO_GIT_CONFIG);
  if (commit) { g("add", "-A"); g("commit", "-q", "-m", message, "--no-verify"); }
}

// Detach every test's git from the DEVELOPER's git. Without this the suite
// inherits whatever is in ~/.gitconfig and /etc/gitconfig — `init.defaultBranch`,
// `core.autocrlf`, `commit.gpgsign`, an `includeIf`, a global `core.hooksPath` —
// so a test can pass on one machine and fail on another for reasons no assertion
// mentions. gitInit() already pins the few settings it cares about locally; this
// closes the rest.
//
// Points at a path that does not exist rather than /dev/null: git treats a missing
// config file as empty everywhere, while /dev/null is not a path on Windows, which
// the CI matrix now covers.
const NO_GIT_CONFIG = join(tmpdir(), "agentmap-no-such-gitconfig");
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: NO_GIT_CONFIG,
  GIT_CONFIG_SYSTEM: NO_GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
};

// Run a raw git command in `dir`. Throws on failure (callers expect git to work).
export function git(dir, ...args) {
  return execFileSync("git", args, {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...GIT_ENV },
  });
}

// Every synchronous CLI invocation below gets a hard ceiling: if agentmap ever
// wedges (e.g. a catastrophic-backtracking regex, an infinite loop introduced
// mid-development), execFileSync/spawnSync's OWN timeout kills it deterministically
// instead of blocking forever. Generous so normal runs never come close to it —
// this is a backstop, not a budget. (Confirmed bug: without this, a hung child
// outlives a runner that gets SIGTERM'd by an external test-timeout, re-parented
// to pid 1 and spinning forever — see killChild()/trackChild() below for the
// equivalent guard on the long-running `--mcp` server subprocess tests.)
const CHILD_TIMEOUT_MS = 60_000;

// Run the CLI: `node agentmap.mjs <args...>` in `dir`. Never throws on a non-zero
// exit — we capture { stdout, stderr, status } so tests can assert exit codes.
export function run(dir, ...args) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTMAP, ...args], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      // generous buffer; map output on big repos can be large
      maxBuffer: 64 * 1024 * 1024,
      timeout: CHILD_TIMEOUT_MS,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    // execFileSync attaches stdout/stderr/status on the thrown error for
    // non-zero exits (and signal/spawn failures) — including a timeout kill.
    return {
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? "",
      status: typeof e.status === "number" ? e.status : 1,
    };
  }
}

// Like run() but ALWAYS captures stderr (even on a zero exit) via spawnSync — so
// tests can assert on the "# agentmap: parsing N source files…" build log that
// distinguishes a full rebuild from a cache hit. run() drops stderr on success.
export function runErr(dir, ...args) {
  const r = spawnSync(process.execPath, [AGENTMAP, ...args], {
    cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: typeof r.status === "number" ? r.status : 1 };
}

// Like run() but with HOME/USERPROFILE pointed at a throwaway dir first — used
// by --doctor/--setup-mcp tests that must not touch the developer's real global
// configs. (Was copy-pasted verbatim into doctor/exit-code-contract/setup-mcp
// tests, each missing a timeout; consolidated here so the guard lives in one
// place.)
export function runWithHome(dir, homeDir, ...args) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  try {
    const stdout = execFileSync(process.execPath, [AGENTMAP, ...args], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env,
      maxBuffer: 64 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? "",
      status: typeof e.status === "number" ? e.status : 1,
    };
  }
}

// Did this run do a full ts-morph reparse (true) or serve a cache (false)?
export const didReparse = (r) => /parsing \d+ source files/.test(r.stderr);

// Best-effort cleanup of a single repo.
export function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ----------------------------------------------------------------------------
// Long-running subprocess tracking (the `--mcp` server harnesses in
// mcp-inprocess/mcp-protocol spawn `agentmap --mcp` and talk to it over stdio
// for the life of one test). CONFIRMED BUG this fixes: those harnesses only
// killed the child on the happy path — a timed-out or errored call left the
// server running, and once the test process itself got torn down (runner
// timeout, SIGTERM/SIGKILL), the child was re-parented to pid 1 and kept
// running indefinitely (spinning at full CPU if it was ever wedged, which is
// exactly why the call hadn't returned in the first place).
//
// Every spawn of a long-running agentmap subprocess MUST go through
// trackChild() and kill it via killChild() on EVERY exit path (success,
// timeout, error) — not just success.
const _children = new Set();

export function trackChild(child) {
  _children.add(child);
  child.once("exit", () => _children.delete(child));
  return child;
}

// Kill a tracked child deterministically. SIGTERM first (lets it shut down
// cleanly); if it's still alive after a short grace period — e.g. wedged in a
// synchronous hot loop that can't service the signal yet — escalate to
// SIGKILL, which the kernel delivers unconditionally. Safe to call more than
// once, or on a child that has already exited.
export function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch {}
  const t = setTimeout(() => {
    try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch {}
  }, 2000);
  t.unref();
}

// Backstop: remove every temp repo AND kill every still-tracked child when the
// test process exits, even if a test forgot to clean up. force:true so a stray
// lock never crashes the runner.
process.on("exit", () => {
  for (const c of _children) { try { c.kill("SIGKILL"); } catch {} }
  for (const d of _dirs) cleanup(d);
});

// The "exit" backstop above only fires on a normal exit / explicit
// process.exit() — NOT on a raw SIGINT/SIGTERM (e.g. Ctrl-C locally, or a CI
// runner enforcing its own test timeout by signaling this process). Route
// those through process.exit() so the same sweep still runs instead of
// leaking both the fixture dirs and any live `--mcp` server children.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => process.exit(1));
}
