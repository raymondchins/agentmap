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
import { execFileSync } from "node:child_process";

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
  g("config", "core.hooksPath", "/dev/null"); // never fire a real hook during tests
  if (commit) { g("add", "-A"); g("commit", "-q", "-m", message, "--no-verify"); }
}

// Run a raw git command in `dir`. Throws on failure (callers expect git to work).
export function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Run the CLI: `node agentmap.mjs <args...>` in `dir`. Never throws on a non-zero
// exit — we capture { stdout, stderr, status } so tests can assert exit codes.
export function run(dir, ...args) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTMAP, ...args], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      // generous buffer; map output on big repos can be large
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    // execFileSync attaches stdout/stderr/status on the thrown error for
    // non-zero exits (and signal/spawn failures).
    return {
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? "",
      status: typeof e.status === "number" ? e.status : 1,
    };
  }
}

// Best-effort cleanup of a single repo.
export function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Backstop: remove every temp repo when the test process exits, even if a test
// forgot to clean up. force:true so a stray lock never crashes the runner.
process.on("exit", () => { for (const d of _dirs) cleanup(d); });
