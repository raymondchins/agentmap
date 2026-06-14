// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, run, cleanup } from "./helpers.mjs";

// derive the expected version from package.json (NOT hardcoded) so the test
// survives version bumps / merges onto a newer main.
const PKG_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("--install-skill installs project-scoped claude, cursor, agents files", () => {
  const dir = makeRepo({ "src/index.ts": "export function x() { return 1; }" });
  const r = run(dir, "--install-skill");
  assert.equal(r.status, 0, r.stderr);

  const claude = join(dir, ".claude", "skills", "agentmap", "SKILL.md");
  const cursor = join(dir, ".cursor", "rules", "agentmap.mdc");
  const agents = join(dir, ".agents", "skills", "agentmap", "SKILL.md");
  assert.ok(existsSync(claude), "missing Claude SKILL.md");
  assert.ok(existsSync(cursor), "missing Cursor rule");
  assert.ok(existsSync(agents), "missing agents SKILL.md");
  assert.match(readFileSync(claude, "utf8"), /name: agentmap/);
  assert.match(readFileSync(cursor, "utf8"), /alwaysApply: true/);
  assert.equal(readFileSync(join(dir, ".claude", "skills", "agentmap", ".agentmap_version"), "utf8").trim(), PKG_VERSION);
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

test("--install-skill is idempotent", () => {
  const dir = makeRepo({});
  assert.equal(run(dir, "--install-skill", "--platform", "claude").status, 0);
  assert.equal(run(dir, "--install-skill", "--platform", "claude").status, 0);
  cleanup(dir);
});
