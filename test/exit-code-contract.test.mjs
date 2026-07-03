// SPDX-License-Identifier: MIT
// Task 8 — exit-code contract. Reserves exit 1 for "query had zero results"
// (now including an unresolved --map --focus, which used to silently degrade to
// the global digest at exit 0), and moves maintenance-command failures to exit 3
// (they used to collide with the exit-1 "zero results" bucket). Also asserts the
// additive `focusResolved` field in --map --json output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup, AGENTMAP } from "./helpers.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
  "src/index.ts": `export function realSymbol() { return 1; }`,
};
function repo() { const dir = makeRepo(FIXTURE); gitInit(dir, { commit: true }); return dir; }

// Like helpers.run() but with HOME/USERPROFILE pointed at a throwaway dir so the
// maintenance-failure case can plant a malformed global config safely.
function runWithHome(dir, homeDir, ...args) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  try {
    const stdout = execFileSync(process.execPath, [AGENTMAP, ...args], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    return { stdout: e.stdout?.toString?.() ?? "", stderr: e.stderr?.toString?.() ?? "", status: typeof e.status === "number" ? e.status : 1 };
  }
}

test("--map --focus <nonexistent> → exit 1, still prints a digest, focusResolved:false in --json", () => {
  const dir = repo();
  const prose = run(dir, "--map", "--focus", "zzz_no_such_file_zz");
  assert.equal(prose.status, 1, `expected exit 1 for unresolved --focus, got ${prose.status}\n${prose.stdout}${prose.stderr}`);
  assert.match(prose.stderr, /--focus.*using global ranking/, "expected the degrade warning on stderr");
  assert.match(prose.stdout, /# agentmap \(/, "expected the global digest to still print");

  const j = run(dir, "--json", "--map", "--focus", "zzz_no_such_file_zz");
  assert.equal(j.status, 1, `expected exit 1 in --json mode too, got ${j.status}`);
  const o = JSON.parse(j.stdout);
  assert.equal(o.command, "map");
  assert.equal(o.focusResolved, false, "expected focusResolved:false for an unresolved --focus");
  assert.ok(Array.isArray(o.files), "digest files array must still be present (fallback still useful)");
  cleanup(dir);
});

test("--map --focus <real file> → exit 0 with focusResolved:true", () => {
  const dir = repo();
  const j = run(dir, "--json", "--map", "--focus", "index.ts");
  assert.equal(j.status, 0, j.stderr);
  const o = JSON.parse(j.stdout);
  assert.equal(o.command, "map");
  assert.equal(o.focusResolved, true, "expected focusResolved:true for a resolved --focus");
  assert.match(o.focus, /index\.ts$/, "focus label should be the resolved file key");
  cleanup(dir);
});

test("--map with no --focus → exit 0 and omits focusResolved", () => {
  const dir = repo();
  const j = run(dir, "--json", "--map");
  assert.equal(j.status, 0, j.stderr);
  const o = JSON.parse(j.stdout);
  assert.equal(o.command, "map");
  assert.equal(o.focus, "global");
  assert.ok(!("focusResolved" in o), "focusResolved must be omitted when --focus wasn't requested");
  cleanup(dir);
});

test("maintenance failure → exit 3, not 1 (--setup-mcp with malformed global config)", () => {
  const dir = repo();
  const home = makeRepo({});
  const openCodeDir = join(home, ".config", "opencode");
  mkdirSync(openCodeDir, { recursive: true });
  writeFileSync(join(openCodeDir, "opencode.json"), "{ malformed json }");

  const r = runWithHome(dir, home, "--setup-mcp");
  assert.equal(r.status, 3, `expected exit 3 for a maintenance failure, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /agentmap --setup-mcp failed/);
  cleanup(dir); cleanup(home);
});

test("empty --find <nomatch> stays exit 1 (query zero-results, unchanged)", () => {
  const dir = repo();
  const r = run(dir, "--find", "zzzznomatch");
  assert.equal(r.status, 1, `expected exit 1 for empty --find, got ${r.status}`);
  cleanup(dir);
});
