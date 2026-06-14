// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, run, cleanup } from "./helpers.mjs";

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
  assert.ok(!existsSync(join(dir, ".config", "opencode", "skills", "agentmap", "SKILL.md")));
  cleanup(dir);
});

test("--install-skill --global --platform antigravity --dry-run targets ~/.gemini/config/skills", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--global", "--platform", "antigravity", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.gemini[/\\]config[/\\]skills[/\\]agentmap[/\\]SKILL\.md/);
  cleanup(dir);
});

test("--install-skill --global --platform opencode --dry-run targets ~/.config/opencode/skills", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--global", "--platform", "opencode", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.config[/\\]opencode[/\\]skills[/\\]agentmap[/\\]SKILL\.md/);
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

test("--install-skill --platform all,agents expands and dedupes", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "all,agents", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skip.*legacy.*same path/s);
  cleanup(dir);
});

test("--install-skill unknown platform fails", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "notaplatform");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown platform/);
  cleanup(dir);
});

test("--install-skill is idempotent", () => {
  const dir = makeRepo({});
  assert.equal(run(dir, "--install-skill", "--platform", "claude").status, 0);
  assert.equal(run(dir, "--install-skill", "--platform", "claude").status, 0);
  cleanup(dir);
});
