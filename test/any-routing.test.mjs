// SPDX-License-Identifier: MIT
// Contract #2 — `--any` routing precedence + the SHADOWING fix.
// `--any` routes file → symbol → feature → live content. The bug: a query that
// substring-matches a FILE PATH used to short-circuit to the file branch and
// HIDE symbol matches living in other files. Post-fix, `--any auth` must still
// surface the `authenticate` symbol even though `authHelpers.ts` collides on
// the path substring "auth".
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// authHelpers.ts: path contains "auth" but exports NOTHING named like the query.
// login.ts: exports `authenticate` — the symbol we must not lose.
const FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
  "src/authHelpers.ts": `export function sanitize(x: string) { return x.trim(); }`,
  "src/login.ts": `export function authenticate(u: string, p: string) { return u === p; }`,
  "src/app.ts": `import { authenticate } from "./login";\nimport { sanitize } from "./authHelpers";\nexport function run(u: string) { return authenticate(sanitize(u), "x"); }`,
};

test("--any does not let a path-substring collision shadow symbol matches", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", "auth");
  assert.equal(r.status, 0, `--any auth failed: ${r.stderr}`);
  // The `authenticate` symbol (in login.ts) MUST appear — the shadowing fix.
  assert.match(r.stdout, /authenticate/, "expected `authenticate` symbol in --any output");
  cleanup(dir);
});

test("--any exact-file query still routes to the file branch", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", "src/login.ts");
  assert.equal(r.status, 0);
  // Exact path → structured file view (exports / imports / dependents block).
  assert.match(r.stdout, /login\.ts/);
  assert.match(r.stdout, /exports/, "expected file structure block for exact path");
  cleanup(dir);
});

test("--any falls through to live content for a non-symbol string literal", () => {
  const dir = makeRepo({
    ...FIXTURE,
    "src/copy.ts": `export const BANNER = "Welcome to ZZ_MAGIC_STRING dashboard";`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", "ZZ_MAGIC_STRING");
  assert.equal(r.status, 0, `content fallback failed: ${r.stderr}`);
  // No symbol/file/feature named that → git-grep content fallback finds the literal.
  assert.match(r.stdout, /ZZ_MAGIC_STRING/, "expected content-search hit for string literal");
  cleanup(dir);
});
