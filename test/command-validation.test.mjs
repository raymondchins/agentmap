// SPDX-License-Identifier: MIT
// Task 6 — declarative command-table / post-parse validation. Flag parsing is
// order-insensitive set membership, so without a post-parse pass, orphan
// sub-flags (--focus without --map) and conflicting commands (two commands at
// once) are silently accepted — whichever branch matches first in the dispatch
// chain wins. This locks in the new exit-2 contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
  "src/index.ts": `export function realSymbol() { return 1; }`,
};

function repo() { const dir = makeRepo(FIXTURE); gitInit(dir, { commit: true }); return dir; }

test("two commands together → exit 2", () => {
  const dir = repo();
  const r = run(dir, "--map", "--doctor");
  assert.equal(r.status, 2, `expected exit 2 for conflicting commands, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /conflicting commands/i);
  cleanup(dir);
});

test("--focus without --map → exit 2", () => {
  const dir = repo();
  const r = run(dir, "--focus", "src/index.ts");
  assert.equal(r.status, 2, `expected exit 2 for orphan --focus, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--focus requires --map/i);
  cleanup(dir);
});

test("--tokens without --map → exit 2", () => {
  const dir = repo();
  const r = run(dir, "--tokens", "100");
  assert.equal(r.status, 2, `expected exit 2 for orphan --tokens, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--tokens requires --map/i);
  cleanup(dir);
});

test("--platform without --install-skill → exit 2", () => {
  const dir = repo();
  const r = run(dir, "--platform", "claude");
  assert.equal(r.status, 2, `expected exit 2 for orphan --platform, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--platform requires --install-skill/i);
  cleanup(dir);
});

test("--dry-run without --install-hooks or --setup-mcp → exit 2", () => {
  const dir = repo();
  const r = run(dir, "--dry-run");
  assert.equal(r.status, 2, `expected exit 2 for orphan --dry-run, got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--dry-run requires/i);
  cleanup(dir);
});

test("valid --map --focus foo --tokens 100 is accepted (not exit 2)", () => {
  const dir = repo();
  const r = run(dir, "--map", "--focus", "src/index.ts", "--tokens", "100");
  assert.notEqual(r.status, 2, `valid --map combo wrongly rejected: ${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  cleanup(dir);
});

test("--install-hooks --dry-run is accepted", () => {
  const dir = repo();
  const r = run(dir, "--install-hooks", "--dry-run");
  assert.notEqual(r.status, 2, `--install-hooks --dry-run wrongly rejected: ${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  cleanup(dir);
});

test("bare build (no flags) → exit 0", () => {
  const dir = repo();
  const r = run(dir);
  assert.equal(r.status, 0, `bare build should exit 0, got ${r.status}\n${r.stderr}`);
  cleanup(dir);
});

test("--json alone (no command) → exit 0 (global modifier, not a command)", () => {
  const dir = repo();
  const r = run(dir, "--json");
  assert.equal(r.status, 0, `--json alone should exit 0, got ${r.status}\n${r.stderr}`);
  cleanup(dir);
});
