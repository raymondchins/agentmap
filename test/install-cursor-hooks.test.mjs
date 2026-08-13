// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — `--install-skill --platform cursor` writes the shell gate.
//
//  Cursor used to get a rule file and nothing else: advice the model could
//  ignore. These pin the enforcement half — the hook script lands, hooks.json
//  registers it in CURSOR's shape (flat {command, matcher}, NOT Claude's nested
//  {matcher, hooks:[…]}), re-running does not duplicate it, and a hooks.json
//  that already belongs to the user is merged rather than replaced.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, run, runErr, cleanup } from "./helpers.mjs";

const HOOK_REL = join(".cursor", "hooks", "agentmap-cursor-nudge.mjs");
const CONF_REL = join(".cursor", "hooks.json");

function readConf(dir) {
  return JSON.parse(readFileSync(join(dir, CONF_REL), "utf8"));
}

test("--platform cursor installs the hook script alongside the rule", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "cursor");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, ".cursor", "rules", "agentmap.mdc")), "the rule must still install");
  assert.ok(existsSync(join(dir, HOOK_REL)), "the gate script must be copied in");
  assert.ok(existsSync(join(dir, CONF_REL)), "hooks.json must be written");
  cleanup(dir);
});

test("hooks.json uses Cursor's flat entry shape, not Claude's nested one", () => {
  const dir = makeRepo({});
  assert.equal(run(dir, "--install-skill", "--platform", "cursor").status, 0);
  const conf = readConf(dir);
  assert.equal(conf.version, 1, "Cursor keys the file format with a version");
  const entries = conf.hooks.beforeShellExecution;
  assert.ok(Array.isArray(entries) && entries.length === 1, "exactly one entry expected");
  const [entry] = entries;
  assert.match(entry.command, /agentmap-cursor-nudge\.mjs/, "the entry must point at the gate");
  assert.match(entry.command, /^node /, "invoked via node — a shebang + x-bit would not survive Windows");
  assert.match(entry.command, /\.cursor\/hooks\//, "project-scope paths are project-root-relative");
  assert.ok(entry.matcher, "a matcher must narrow the hook to search commands");
  assert.equal(entry.hooks, undefined, "Cursor entries are flat — no nested hooks array");
  assert.equal(entry.timeout, undefined, "no timeout: Cursor documents the value without its unit");
  cleanup(dir);
});

test("the matcher actually matches the searchers the gate cares about", () => {
  const dir = makeRepo({});
  assert.equal(run(dir, "--install-skill", "--platform", "cursor").status, 0);
  const re = new RegExp(readConf(dir).hooks.beforeShellExecution[0].matcher);
  for (const cmd of ["grep -rn Foo src/", "rg '<Bar' src/", "ack Baz"]) {
    assert.ok(re.test(cmd), `matcher must fire on: ${cmd}`);
  }
  cleanup(dir);
});

test("re-running does not duplicate the hooks.json entry", () => {
  const dir = makeRepo({});
  assert.equal(run(dir, "--install-skill", "--platform", "cursor").status, 0);
  const first = readFileSync(join(dir, CONF_REL), "utf8");
  assert.equal(run(dir, "--install-skill", "--platform", "cursor").status, 0);
  assert.equal(readFileSync(join(dir, CONF_REL), "utf8"), first, "second run must be a no-op");
  assert.equal(readConf(dir).hooks.beforeShellExecution.length, 1, "still exactly one entry");
  cleanup(dir);
});

test("an existing user hooks.json is merged, not clobbered", () => {
  const dir = makeRepo({});
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  writeFileSync(
    join(dir, CONF_REL),
    JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: "./hooks/mine.sh", matcher: "curl" }],
        afterFileEdit: [{ command: "./hooks/fmt.sh" }],
      },
    }, null, 2),
  );
  assert.equal(run(dir, "--install-skill", "--platform", "cursor").status, 0);
  const conf = readConf(dir);
  assert.equal(conf.hooks.beforeShellExecution.length, 2, "the user's own gate must survive");
  assert.equal(conf.hooks.beforeShellExecution[0].command, "./hooks/mine.sh", "and stay first");
  assert.ok(conf.hooks.afterFileEdit, "unrelated events must be preserved");
  cleanup(dir);
});

test("a malformed hooks.json fails clean, naming the file, before anything is written", () => {
  const dir = makeRepo({});
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  writeFileSync(join(dir, CONF_REL), "{ this is not json");
  const r = runErr(dir, "--install-skill", "--platform", "cursor");
  assert.notEqual(r.status, 0, "the install must fail rather than silently skip the gate");
  assert.match(r.stderr, /hooks\.json/, "the error must name the offending file");
  assert.ok(!existsSync(join(dir, HOOK_REL)), "no partial install: the hook must not have landed");
  cleanup(dir);
});

test("a hooks.json whose beforeShellExecution is the wrong type is rejected by name", () => {
  const dir = makeRepo({});
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  writeFileSync(join(dir, CONF_REL), JSON.stringify({ hooks: { beforeShellExecution: "nope" } }));
  const r = runErr(dir, "--install-skill", "--platform", "cursor");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /beforeShellExecution/, "the error must name the offending key");
  cleanup(dir);
});

test("--dry-run reports the gate paths and writes nothing", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "cursor", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hooks\.json/, "the plan must mention hooks.json");
  assert.ok(!existsSync(join(dir, HOOK_REL)), "dry-run must not write the hook");
  assert.ok(!existsSync(join(dir, CONF_REL)), "dry-run must not write hooks.json");
  cleanup(dir);
});

test("--global skips the Cursor gate entirely (project-scoped only)", () => {
  const dir = makeRepo({});
  const r = run(dir, "--install-skill", "--platform", "cursor", "--global");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(dir, CONF_REL)), "a global gate would fire in repos with no agentmap");
  cleanup(dir);
});
