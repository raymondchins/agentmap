// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, run, cleanup } from "./helpers.mjs";

test("--install-docs merges GEMINI.md and AGENTS.md (default all)", () => {
  const dir = makeRepo({ "README.md": "# demo\n", "AGENTS.md": "# team rules\n\nKeep tests green.\n" });
  const r = run(dir, "--install-docs");
  assert.equal(r.status, 0, r.stderr);

  const gemini = join(dir, "GEMINI.md");
  const agents = join(dir, "AGENTS.md");
  assert.ok(existsSync(gemini), "missing GEMINI.md");
  assert.ok(existsSync(agents), "missing AGENTS.md");
  assert.match(readFileSync(gemini, "utf8"), /<!-- agentmap:begin -->/);
  assert.match(readFileSync(agents, "utf8"), /Keep tests green/);
  assert.match(readFileSync(agents, "utf8"), /<!-- agentmap:begin -->/);
  assert.match(readFileSync(agents, "utf8"), /agentmap --any/);
  assert.ok(existsSync(join(dir, ".gemini", "hooks", "agentmap-nudge.mjs")));
  assert.ok(existsSync(join(dir, ".gemini", "settings.json")));
  assert.ok(existsSync(join(dir, ".opencode", "plugins", "agentmap-nudge.js")));
  cleanup(dir);
});

test("--install-docs is idempotent on AGENTS.md block", () => {
  const dir = makeRepo({});
  assert.equal(run(dir, "--install-docs", "--platform", "codex").status, 0);
  const first = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal(run(dir, "--install-docs", "--platform", "codex").status, 0);
  const second = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal(first, second);
  cleanup(dir);
});

test("--install-docs --platform gemini --dry-run writes nothing", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-docs", "--platform", "gemini", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--dry-run/);
  assert.ok(!existsSync(join(dir, "GEMINI.md")));
  cleanup(dir);
});

test("--install-docs --global --platform opencode --dry-run targets ~/.config/opencode/AGENTS.md", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-docs", "--global", "--platform", "opencode", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\.config[/\\]opencode[/\\]AGENTS\.md/);
  cleanup(dir);
});

test("--install-docs unknown platform fails", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-docs", "--platform", "cursor");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown platform/);
  cleanup(dir);
});
