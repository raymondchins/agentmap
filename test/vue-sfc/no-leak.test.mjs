// SPDX-License-Identifier: MIT
// Virtual-path leak guard — the single most important contract.
//
// agentmap feeds Vue `<script>` blocks to ts-morph as VIRTUAL source files
// (e.g. `UserCard.vue.ts`). These virtual paths MUST NEVER appear in any
// user-facing output (JSON or prose). This file runs every command against a
// realistic multi-SFC repo and asserts no virtual path leaks anywhere in the
// deeply-walked JSON or in the prose text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, cleanup, run } from "../helpers.mjs";
import { VUE_PROJECT, vueJson, leakedVirtualPaths } from "./fixtures.mjs";

function setup() {
  const dir = makeRepo(VUE_PROJECT);
  gitInit(dir, { commit: true });
  return dir;
}

// Each test runs a different command and deep-walks the result for leaks.

test("no-leak: --print --json", () => {
  const dir = setup();
  const o = vueJson(dir, "--print");
  assert.equal(leakedVirtualPaths(o).length, 0, leakedVirtualPaths(o).join(", "));
  cleanup(dir);
});

test("no-leak: --find <sym>", () => {
  const dir = setup();
  const o = vueJson(dir, "--find", "Marker");
  assert.equal(leakedVirtualPaths(o).length, 0, leakedVirtualPaths(o).join(", "));
  cleanup(dir);
});

test("no-leak: --relates <vue>", () => {
  const dir = setup();
  const o = vueJson(dir, "--relates", "UserCard.vue");
  assert.equal(leakedVirtualPaths(o).length, 0, leakedVirtualPaths(o).join(", "));
  cleanup(dir);
});

test("no-leak: --map + --symbols + --hubs (JSON)", () => {
  const dir = setup();
  for (const args of [["--map"], ["--symbols", "50"], ["--hubs"], ["--features"], ["--any", "Marker"]]) {
    const o = vueJson(dir, ...args);
    const leaks = leakedVirtualPaths(o);
    assert.equal(leaks.length, 0, `leak in --json ${args.join(" ")}: ${leaks.join(", ")}`);
  }
  cleanup(dir);
});

// Prose mode (no --json): grep stdout/stderr for any `.vue.{ts,js,...}` token.
test("no-leak: prose commands (--hubs/--symbols/--map/--relates/--find/--any/--print)", () => {
  const dir = setup();
  for (const args of [["--hubs"], ["--symbols", "10"], ["--map"], ["--relates", "UserCard.vue"], ["--find", "Marker"], ["--any", "UserCard"], ["--print"]]) {
    const r = run(dir, ...args);
    assert.equal(r.status, 0, `--json ${args.join(" ")} exit ${r.status}: ${r.stderr}`);
    const txt = r.stdout + r.stderr;
    assert.ok(!/\.vue\.(ts|js|mjs|cjs|tsx|jsx)/i.test(txt), `prose leak in ${args.join(" ")}:\n${txt}`);
  }
  cleanup(dir);
});
