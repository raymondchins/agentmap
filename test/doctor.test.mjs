// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { makeRepo, gitInit, run, git, cleanup, AGENTMAP } from "./helpers.mjs";

// Same HOME-isolation pattern as test/setup-mcp.test.mjs — doctor scans
// ~/.config/opencode etc., so MCP tests must override HOME to avoid touching
// the developer's real global configs.
function runWithHome(dir, homeDir, ...args) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  try {
    const stdout = execFileSync(process.execPath, [AGENTMAP, ...args], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env,
      maxBuffer: 64 * 1024 * 1024,
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

// Recursive file listing under `dir` — for the no-writes invariant.
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

const SCHEMA = 4; // keep in sync with SCHEMA_VERSION in agentmap.mjs

// ----------------------------------------------------------------------------

test("--doctor: fresh repo, nothing installed, exits 0", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /agentmap doctor/);
  assert.match(r.stdout, /post-commit: missing/);
  assert.match(r.stdout, /PreToolUse\(Grep\): missing/);
  assert.match(r.stdout, /PreToolUse\(Bash\): missing/);
  assert.match(r.stdout, /Map cache: missing/);
  assert.match(r.stdout, /Suggested next steps/);
  cleanup(dir);
});

test("--doctor: partial hooks reports exact gaps", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  // Foreign post-commit without marker.
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  writeFileSync(join(dir, ".git", "hooks", "post-commit"), "#!/bin/sh\necho foreign\n", { mode: 0o755 });
  // Nudge present, Grep wired, Bash NOT wired.
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(dir, ".claude", "hooks", "agentmap-nudge.mjs"), "// nudge\n");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{
      matcher: "Grep",
      hooks: [{ type: "command", command: "node .claude/hooks/agentmap-nudge.mjs" }],
    }] },
  }));
  writeFileSync(join(dir, ".gitignore"), ".claude/agentmap/\n");

  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /post-commit: missing .*hook exists but agentmap not found/);
  assert.match(r.stdout, /PreToolUse\(Grep\): wired/);
  assert.match(r.stdout, /PreToolUse\(Bash\): missing/);
  assert.match(r.stdout, /\.gitignore.*: ok/);
  cleanup(dir);
});

test("--doctor: healthy install via --install-hooks reports green hooks", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  assert.equal(run(dir, "--install-hooks").status, 0);
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /post-commit: installed/);
  assert.match(r.stdout, /nudge.*: installed/);
  assert.match(r.stdout, /PreToolUse\(Grep\): wired/);
  assert.match(r.stdout, /PreToolUse\(Bash\): wired/);
  assert.match(r.stdout, /\.gitignore.*: ok/);
  cleanup(dir);
});

test("--doctor: outside a git repo degrades gracefully (still exit 0)", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  // NOTE: no gitInit — outside a repo.
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Git repo: skipped/);
  assert.match(r.stdout, /post-commit: skipped/);
  // Repo-local checks still run.
  assert.match(r.stdout, /PreToolUse\(Grep\)/);
  assert.match(r.stdout, /Skills \/ Rules/);
  assert.match(r.stdout, /Map cache/);
  cleanup(dir);
});

test("--doctor: invalid .claude/settings.json surfaces as invalid, not a crash", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{not valid json");
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PreToolUse\(Grep\): invalid/);
  assert.match(r.stdout, /PreToolUse\(Bash\): invalid/);
  cleanup(dir);
});

test("--doctor: stale skill version is flagged", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  assert.equal(run(dir, "--install-skill", "--platform", "claude").status, 0);
  // Corrupt the version marker to force a stale report.
  const versionPath = join(dir, ".claude", "skills", "agentmap", ".agentmap_version");
  assert.equal(existsSync(versionPath), true, "install-skill should write .agentmap_version");
  writeFileSync(versionPath, "0.0.0\n");
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Claude Code: stale/);
  assert.match(r.stdout, /agentmap --install-skill/);
  cleanup(dir);
});

test("--doctor: MCP wiring statuses (wired / invalid / missing-entry)", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  const home = makeRepo({});
  // OpenCode: wired.
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
    mcp: { agentmap: { type: "stdio", command: "agentmap" } },
  }));
  // Antigravity IDE: malformed JSON.
  mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true });
  writeFileSync(join(home, ".gemini", "antigravity", "mcp_config.json"), "{ malformed");
  // Antigravity shared: valid JSON, no agentmap entry.
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify({ mcpServers: {} }));

  const r = runWithHome(dir, home, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OpenCode: wired/);
  assert.match(r.stdout, /Antigravity IDE: invalid/);
  assert.match(r.stdout, /Antigravity \(shared\): missing/);
  cleanup(dir); cleanup(home);
});

test("--doctor: missing map cache reported as missing", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Map cache: missing/);
  cleanup(dir);
});

test("--doctor: fresh map cache with matching SHA + schema reports ok", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  const sha = git(dir, "rev-parse", "--short", "HEAD").trim();
  mkdirSync(join(dir, ".claude", "agentmap"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agentmap", "map.json"), JSON.stringify({
    schema: SCHEMA, generatedSha: sha, files: {},
  }));
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Map cache: ok/);
  cleanup(dir);
});

test("--doctor: dirty working tree marks cache stale", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  const sha = git(dir, "rev-parse", "--short", "HEAD").trim();
  mkdirSync(join(dir, ".claude", "agentmap"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agentmap", "map.json"), JSON.stringify({
    schema: SCHEMA, generatedSha: sha, files: {},
  }));
  // Mutate a .ts file without committing → dirtyCount > 0.
  writeFileSync(join(dir, "src", "x.ts"), "export const x = 2;\n");
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Map cache: stale/);
  assert.match(r.stdout, /dirty|source change/);
  cleanup(dir);
});

test("--doctor --json: emits valid structured report", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  const r = run(dir, "--doctor", "--json");
  assert.equal(r.status, 0, r.stderr);
  let parsed;
  try { parsed = JSON.parse(r.stdout); }
  catch { assert.fail("--doctor --json output must be valid JSON"); }
  assert.equal(parsed.command, "doctor");
  assert.equal(typeof parsed.overall, "string");
  assert.ok(Array.isArray(parsed.checks.hooks));
  assert.ok(Array.isArray(parsed.checks.skills));
  assert.ok(Array.isArray(parsed.checks.mcp));
  assert.ok(Array.isArray(parsed.checks.map));
  assert.ok(Array.isArray(parsed.suggestions));
  cleanup(dir);
});

test("--doctor: never writes any file (read-only invariant)", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  const before = tree(dir);
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  const after = tree(dir);
  assert.deepEqual(after, before, "--doctor must not create or delete any file");
  cleanup(dir);
});
