// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { makeRepo, gitInit, run, runWithHome, git, cleanup } from "./helpers.mjs";

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

// Read the live constant instead of restating it. The hand-synced copy that used
// to live here went stale on the very next schema bump, and a test asserting
// "schema 5 reports ok" against a binary writing schema 6 fails for a reason that
// has nothing to do with --doctor.
import { SCHEMA_VERSION as SCHEMA } from "../agentmap.mjs";

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
  // "Healthy" has to mean a repo where the hook can actually fire. gitInit points
  // core.hooksPath at a nonexistent dir so stray hooks never run in the harness —
  // leave it set and --doctor correctly reports the hook as INERT, because git
  // really would not run it. Unset it so this test describes the shape it claims.
  git(dir, "config", "--unset", "core.hooksPath");
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

// Map HEALTH, not just freshness. build() has always persisted fileCount /
// edgeCoverage / degraded and warned on stderr at build time, but collectMapStatus()
// read none of them — so a map of ZERO files reported "Map cache: ok" forever after
// the one warning scrolled past. Fresh-and-empty is worse than stale: stale tells
// you to rebuild, "ok" tells you nothing is wrong.
test("--doctor: a 0-file map is invalid, not ok", () => {
  const dir = makeRepo({ "README.md": "# no sources\n" });
  gitInit(dir, { commit: true });
  const sha = git(dir, "rev-parse", "--short", "HEAD").trim();
  mkdirSync(join(dir, ".claude", "agentmap"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agentmap", "map.json"), JSON.stringify({
    schema: SCHEMA, generatedSha: sha, fileCount: 0, edgeCoverage: null, degraded: false, files: {},
  }));
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr); // documented contract: --doctor always exits 0
  assert.doesNotMatch(r.stdout, /Map cache: ok/, "a map with zero source files must not report ok");
  assert.match(r.stdout, /Map cache: invalid/);
  assert.match(r.stdout, /0 source files/);
  cleanup(dir);
});

test("--doctor: a degraded map (imports unresolved) is surfaced", () => {
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  const sha = git(dir, "rev-parse", "--short", "HEAD").trim();
  mkdirSync(join(dir, ".claude", "agentmap"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agentmap", "map.json"), JSON.stringify({
    schema: SCHEMA, generatedSha: sha, fileCount: 154, edgeCoverage: 0.02, degraded: true, files: {},
  }));
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Map cache: ok/);
  assert.match(r.stdout, /Map cache: degraded/);
  assert.match(r.stdout, /2\.0%/, "should report the measured edge coverage");
  cleanup(dir);
});

test("--doctor --json: overall reflects map health, not just freshness", () => {
  const dir = makeRepo({ "README.md": "# no sources\n" });
  gitInit(dir, { commit: true });
  const sha = git(dir, "rev-parse", "--short", "HEAD").trim();
  mkdirSync(join(dir, ".claude", "agentmap"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agentmap", "map.json"), JSON.stringify({
    schema: SCHEMA, generatedSha: sha, fileCount: 0, degraded: false, files: {},
  }));
  const report = JSON.parse(run(dir, "--doctor", "--json").stdout);
  assert.equal(report.checks.map[0].status, "invalid");
  assert.notEqual(report.overall, "ok", "an unusable map must not roll up to overall: ok");
  cleanup(dir);
});

test("--doctor: pre-schema-5 caches without health fields still report ok", () => {
  // Backward compat: `undefined` must read as "unknown", never as 0 / degraded —
  // otherwise every older cache suddenly reports invalid.
  const dir = makeRepo({ "src/x.ts": "export const x = 1;\n" });
  gitInit(dir, { commit: true });
  const sha = git(dir, "rev-parse", "--short", "HEAD").trim();
  mkdirSync(join(dir, ".claude", "agentmap"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agentmap", "map.json"), JSON.stringify({
    schema: SCHEMA, generatedSha: sha, files: {}, // no fileCount / degraded
  }));
  const r = run(dir, "--doctor");
  assert.match(r.stdout, /Map cache: ok/);
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
