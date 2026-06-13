// SPDX-License-Identifier: MIT
// Contract #6 — graceful degradation in a NON-git directory, and Contract #7 —
// monorepo / narrow-tsconfig coverage (always-run-broad-globs fix).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// --- Contract #6: no git at all -------------------------------------------
test("non-git repo: --hubs does not crash and exits 0", () => {
  // NOTE: no gitInit — bare directory with one source file.
  const dir = makeRepo({ "only.ts": `export function lonely() { return 1; }` });
  const r = run(dir, "--hubs");
  assert.equal(r.status, 0, `--hubs crashed in non-git repo (status ${r.status}): ${r.stderr}`);
  cleanup(dir);
});

test("non-git repo: --map does not crash and exits 0", () => {
  const dir = makeRepo({ "only.ts": `export function lonely() { return 1; }` });
  const r = run(dir, "--map");
  assert.equal(r.status, 0, `--map crashed in non-git repo (status ${r.status}): ${r.stderr}`);
  // --map must never render empty even for a default-export-light repo.
  assert.match(r.stdout, /agentmap/, "expected a --map header");
  cleanup(dir);
});

test("non-git repo: bare build does not crash and exits 0", () => {
  const dir = makeRepo({ "only.ts": `export function lonely() { return 1; }` });
  const r = run(dir);
  assert.equal(r.status, 0, `bare build crashed in non-git repo: ${r.stderr}`);
  cleanup(dir);
});

// --- Contract #7: narrow tsconfig `include`, source in a sibling subdir -----
test("narrow tsconfig include still indexes sibling-dir source (broad-glob fix)", () => {
  // tsconfig include is scoped to packages/api ONLY, but there's source under
  // packages/web. The always-run-broad-globs fallback must index the sibling.
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { allowJs: true },
      include: ["packages/api/**/*.ts"], // deliberately narrow
    }),
    "packages/api/server.ts": `export function apiHandler() { return 200; }`,
    "src/orphanInSrc.ts": `export function siblingSymbolABC() { return 7; }`,
    "lib/orphanInLib.ts": `export function libSymbolDEF() { return 8; }`,
  });
  gitInit(dir, { commit: true });

  // The api file inside the include must be found.
  const api = run(dir, "--find", "apiHandler");
  assert.equal(api.status, 0, api.stderr);
  assert.match(api.stdout, /apiHandler/);

  // The sibling src/ symbol — OUTSIDE the tsconfig include — must ALSO be found.
  const sib = run(dir, "--find", "siblingSymbolABC");
  assert.equal(sib.status, 0, `sibling src/ symbol not indexed (status ${sib.status}): ${sib.stderr}\n${sib.stdout}`);
  assert.match(sib.stdout, /siblingSymbolABC/, "narrow tsconfig hid sibling src/ source");

  // And the lib/ sibling too.
  const lib = run(dir, "--find", "libSymbolDEF");
  assert.equal(lib.status, 0, lib.stderr);
  assert.match(lib.stdout, /libSymbolDEF/, "narrow tsconfig hid sibling lib/ source");
  cleanup(dir);
});
