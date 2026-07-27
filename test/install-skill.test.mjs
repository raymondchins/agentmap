// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, run, runErr, runWithHome, cleanup } from "./helpers.mjs";

const PKG_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("--install-skill installs project-scoped claude, cursor, antigravity files (default all)", () => {
  const dir = makeRepo({ "src/index.ts": "export function x() { return 1; }" });
  const r = run(dir, "--install-skill");
  assert.equal(r.status, 0, r.stderr);

  const claude = join(dir, ".claude", "skills", "agentmap", "SKILL.md");
  const cursor = join(dir, ".cursor", "rules", "agentmap.mdc");
  const antigravity = join(dir, ".agents", "skills", "agentmap", "SKILL.md");
  const codex = join(dir, ".codex", "skills", "agentmap", "SKILL.md");
  const opencode = join(dir, ".opencode", "skills", "agentmap", "SKILL.md");
  assert.ok(existsSync(claude), "missing Claude SKILL.md");
  assert.ok(existsSync(cursor), "missing Cursor rule");
  assert.ok(existsSync(antigravity), "missing antigravity SKILL.md");
  assert.ok(existsSync(codex), "missing codex SKILL.md");
  assert.ok(existsSync(opencode), "missing opencode SKILL.md");
  assert.ok(existsSync(join(dir, ".gemini", "skills", "agentmap", "SKILL.md")), "missing gemini SKILL.md");
  assert.ok(existsSync(join(dir, ".copilot", "skills", "agentmap", "SKILL.md")), "missing copilot SKILL.md");
  assert.match(readFileSync(claude, "utf8"), /name: agentmap/);
  assert.match(readFileSync(cursor, "utf8"), /alwaysApply: true/);
  assert.equal(readFileSync(join(dir, ".claude", "skills", "agentmap", ".agentmap_version"), "utf8").trim(), PKG_VERSION);
  cleanup(dir);
});

test("--install-skill merges GEMINI.md, AGENTS.md, hooks, and plugin (default all)", () => {
  const dir = makeRepo({ "README.md": "# demo\n", "AGENTS.md": "# team rules\n\nKeep tests green.\n" });
  const r = run(dir, "--install-skill");
  assert.equal(r.status, 0, r.stderr);

  assert.ok(existsSync(join(dir, "GEMINI.md")), "missing GEMINI.md");
  assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /Keep tests green/);
  assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /<!-- agentmap:begin -->/);
  assert.ok(existsSync(join(dir, ".gemini", "hooks", "agentmap-nudge.mjs")));
  assert.ok(existsSync(join(dir, ".gemini", "settings.json")));
  assert.ok(existsSync(join(dir, ".opencode", "plugins", "agentmap-nudge.js")));
  cleanup(dir);
});

test("--install-skill is idempotent on AGENTS.md block", () => {
  const dir = makeRepo({});
  assert.equal(run(dir, "--install-skill", "--platform", "codex").status, 0);
  const first = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal(run(dir, "--install-skill", "--platform", "codex").status, 0);
  assert.equal(first, readFileSync(join(dir, "AGENTS.md"), "utf8"));
  cleanup(dir);
});

test("--install-skill --platform agents still installs legacy .agents path", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "agents");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, ".agents", "skills", "agentmap", "SKILL.md")));
  cleanup(dir);
});

test("--install-skill --platform opencode uses .opencode/skills project path", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "opencode");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, ".opencode", "skills", "agentmap", "SKILL.md")));
  assert.ok(existsSync(join(dir, ".opencode", "plugins", "agentmap-nudge.js")));
  assert.ok(existsSync(join(dir, "AGENTS.md")));
  assert.ok(!existsSync(join(dir, ".config", "opencode", "skills", "agentmap", "SKILL.md")));
  cleanup(dir);
});

test("--install-skill --platform gemini installs GEMINI.md and hooks", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "gemini");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, "GEMINI.md")));
  assert.ok(existsSync(join(dir, ".gemini", "hooks", "agentmap-nudge.mjs")));
  cleanup(dir);
});

test("--install-skill --global --platform antigravity --dry-run targets ~/.gemini/config/skills", () => {
  const dir = makeRepo({});
  const home = makeRepo({});
  const r = runWithHome(dir, home, "--install-skill", "--global", "--platform", "antigravity", "--dry-run");
  assert.ok(r.stdout.includes(home), "global paths did not resolve against the fake HOME");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.gemini[/\\]config[/\\]skills[/\\]agentmap[/\\]SKILL\.md/);
  cleanup(dir);
});

test("--install-skill --global --platform opencode --dry-run targets ~/.config/opencode/skills and AGENTS.md", () => {
  const dir = makeRepo({});
  const home = makeRepo({});
  const r = runWithHome(dir, home, "--install-skill", "--global", "--platform", "opencode", "--dry-run");
  assert.ok(r.stdout.includes(home), "global paths did not resolve against the fake HOME");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.config[/\\]opencode[/\\]skills[/\\]agentmap[/\\]SKILL\.md/);
  assert.match(r.stdout, /\.config[/\\]opencode[/\\]AGENTS\.md/);
  assert.doesNotMatch(r.stdout, /\.opencode[/\\]skills[/\\]agentmap/);
  cleanup(dir);
});

test("--install-skill --platform cursor --dry-run writes nothing", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "cursor", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--dry-run/);
  assert.ok(!existsSync(join(dir, ".cursor", "rules", "agentmap.mdc")));
  cleanup(dir);
});

test("--install-skill --platform gemini --dry-run writes nothing", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "gemini", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--dry-run/);
  assert.ok(!existsSync(join(dir, "GEMINI.md")));
  cleanup(dir);
});

test("--install-skill --platform all,agents expands and dedupes", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "all,agents", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skip.*skill.*same path/s);
  cleanup(dir);
});

test("--install-skill unknown platform fails", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "notaplatform");
  assert.equal(r.status, 3, "maintenance-command failure → exit 3 (exit-code contract)");
  assert.match(r.stderr, /unknown platform/);
  cleanup(dir);
});

test("--install-skill is idempotent", () => {
  const dir = makeRepo({});
  assert.equal(run(dir, "--install-skill", "--platform", "claude").status, 0);
  assert.equal(run(dir, "--install-skill", "--platform", "claude").status, 0);
  cleanup(dir);
});

// --- installer robustness: a malformed settings.json must not half-install ----

test("a non-object hooks key fails with a named error, not an opaque TypeError", () => {
  // `settings.hooks ??= {}` only fills null/undefined, so a string sailed through
  // and threw ".some is not a function" two lines later.
  const dir = makeRepo({ ".gemini/settings.json": JSON.stringify({ hooks: "nope" }, null, 2) });
  const r = run(dir, "--install-skill", "--platform", "gemini");
  assert.notEqual(r.status, 0, "a malformed settings.json should fail the install");
  const msg = r.stdout + r.stderr;
  assert.match(msg, /\.gemini\/settings\.json/, "the error does not name the offending file");
  assert.match(msg, /"hooks" must be an object/, "the error does not name the offending key");
  assert.doesNotMatch(msg, /is not a function/, "still throwing the opaque TypeError");
  cleanup(dir);
});

test("a non-array hooks.BeforeTool fails with a named error", () => {
  const dir = makeRepo({ ".gemini/settings.json": JSON.stringify({ hooks: { BeforeTool: 42 } }, null, 2) });
  const r = run(dir, "--install-skill", "--platform", "gemini");
  assert.notEqual(r.status, 0, "a malformed hooks.BeforeTool should fail the install");
  assert.match(r.stdout + r.stderr, /"hooks\.BeforeTool" must be an array/, "the error does not name the offending key");
  cleanup(dir);
});

test("a malformed config for ONE platform installs nothing for the others", () => {
  // The whole point of the preflight. Before it, `--install-skill` (all platforms)
  // wrote Claude/Cursor/Codex first and only then hit Gemini's broken settings.json,
  // leaving a repo that was neither installed nor untouched.
  const dir = makeRepo({
    "src/index.ts": "export function x() { return 1; }",
    ".gemini/settings.json": JSON.stringify({ hooks: "nope" }, null, 2),
  });
  const r = run(dir, "--install-skill");
  assert.notEqual(r.status, 0, "install should fail while any platform's config is malformed");
  for (const p of [
    join(dir, ".claude", "skills", "agentmap", "SKILL.md"),
    join(dir, ".cursor", "rules", "agentmap.mdc"),
    join(dir, ".codex", "skills", "agentmap", "SKILL.md"),
    join(dir, ".opencode", "skills", "agentmap", "SKILL.md"),
  ]) {
    assert.equal(existsSync(p), false, `partial install: ${p} was written despite the failure`);
  }
  cleanup(dir);
});

test("comments in settings.json are reported as dropped, not deleted in silence", () => {
  // JSON.stringify cannot round-trip JSONC. The comments go; the user gets told.
  const dir = makeRepo({
    ".gemini/settings.json": '{\n  // keep an eye on this\n  "theme": "dark"\n}\n',
  });
  const r = runErr(dir, "--install-skill", "--platform", "gemini");
  assert.equal(r.status, 0, r.stderr);
  const msg = r.stdout + r.stderr;
  assert.match(msg, /contained comments/i, "no warning that JSONC comments were dropped");
  const after = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf8"));
  assert.equal(after.theme, "dark", "the surrounding settings were not preserved");
  assert.ok(Array.isArray(after.hooks?.BeforeTool), "the hook was not actually registered");
  cleanup(dir);
});

test("a comment-free settings.json triggers no comment warning", () => {
  const dir = makeRepo({ ".gemini/settings.json": JSON.stringify({ theme: "dark" }, null, 2) });
  const r = runErr(dir, "--install-skill", "--platform", "gemini");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /contained comments/i, "false comment warning on plain JSON");
  cleanup(dir);
});
