// SPDX-License-Identifier: MIT
// Contract #8 — git-grep injection safety regression.
// The --any content fallback runs `git grep` over the repo. It MUST treat the
// query as a literal pattern via execFile (argv array, no shell) + `-F` fixed
// string + `-e` end-of-options, so neither shell metacharacters nor a
// leading-dash "option-looking" query can execute anything or be parsed as a
// git flag. We assert: (a) no side-effect file is created, (b) the process
// stays inert and exits with a normal contract code (0 on a real hit, 1 on no
// match) — never a crash/usage error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
  "src/index.ts": `export function realSymbol() { return 1; }`,
};

test('--any "; touch PWNED" runs inert — no PWNED file created', () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", "; touch PWNED");
  // Treated as a literal pattern → no shell, no side effect.
  assert.ok(!existsSync(join(dir, "PWNED")), "PWNED file was created — shell injection!");
  // No match for that literal → contract exit 1 (a no-result query), NOT a crash.
  assert.equal(r.status, 1, `expected inert no-match exit 1, got ${r.status}: ${r.stderr}`);
  cleanup(dir);
});

test('--any "-O/bin/sh" is treated as a literal, not a git-grep flag', () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", "-O/bin/sh");
  // Leading-dash query must NOT be parsed as a git option (would be a different
  // exit / error). It's a known agentmap flag? No — but it IS passed as the
  // VALUE of --any, so it must reach the content branch and find nothing.
  assert.ok(!existsSync(join(dir, "sh")), "unexpected side-effect file");
  // No content match for that literal → exit 1, inert.
  assert.equal(r.status, 1, `expected inert no-match exit 1 for dash-query, got ${r.status}: ${r.stderr}`);
  // Must NOT surface a git error to the user.
  assert.doesNotMatch(r.stdout + r.stderr, /fatal:|unknown switch|invalid option/i, "git error leaked for dash-query");
  cleanup(dir);
});

test('sensitive files are excluded from the --any content sweep (no secret leak)', () => {
  // A value living in a conventionally-named secret file must NOT be surfaced by
  // the content fallback (it would otherwise be fed to the LLM via --any / MCP).
  // Covers the *password* fix: a plain password.txt, not just foo.password.ts.
  const SECRET = "SUPER_SECRET_VALUE_ZZQ";
  const dir = makeRepo({
    ...FIXTURE,
    ".env": `API_KEY=${SECRET}\n`,
    "passwords.txt": `${SECRET}\n`,
    "deploy.key": `${SECRET}\n`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", SECRET);
  assert.doesNotMatch(r.stdout, /passwords\.txt|deploy\.key|\.env/, "a sensitive file leaked into content-search results");
  // With every hit excluded, the query resolves to no results (contract exit 1).
  assert.equal(r.status, 1, `expected no-result exit 1 after excluding secrets, got ${r.status}: ${r.stderr}`);
  cleanup(dir);
});

test('expanded denylist: key/keystore/SSH/credential-dotfile secrets are excluded', () => {
  const SECRET = "EXPANDED_SECRET_VALUE_ZZQ";
  const dir = makeRepo({
    ...FIXTURE,
    ".npmrc": `//registry.npmjs.org/:_authToken=${SECRET}\n`,
    ".pgpass": `localhost:5432:db:user:${SECRET}\n`,
    ".git-credentials": `https://user:${SECRET}@github.com\n`,
    "id_ed25519": `${SECRET}\n`,
    "service.p8": `${SECRET}\n`,
    "app.keystore": `${SECRET}\n`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", SECRET);
  assert.doesNotMatch(r.stdout, /\.npmrc|\.pgpass|\.git-credentials|id_ed25519|service\.p8|app\.keystore/, "an expanded-denylist secret file leaked into content-search results");
  assert.equal(r.status, 1, `expected no-result exit 1 after excluding expanded secrets, got ${r.status}: ${r.stderr}`);
  cleanup(dir);
});

test('denylist does NOT over-exclude: a tokenizer.ts source file stays searchable', () => {
  // The expanded denylist deliberately omits a bare `token` substring match — an
  // ordinary source file like tokenizer.ts must remain content-searchable.
  const dir = makeRepo({
    ...FIXTURE,
    "src/tokenizer.ts": `export const MARKER = "FINDABLE_TOKENIZER_LITERAL";`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", "FINDABLE_TOKENIZER_LITERAL");
  assert.equal(r.status, 0, `tokenizer.ts literal should be found, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /tokenizer\.ts/, "tokenizer.ts was wrongly excluded from content search");
  cleanup(dir);
});

test('a literal that DOES exist still matches inertly (positive control)', () => {
  // Prove the content path actually works for a benign literal containing a
  // metacharacter-ish token, so the inert-on-injection result above isn't just
  // "content search is broken for everything".
  const dir = makeRepo({
    ...FIXTURE,
    "src/note.ts": `export const NOTE = "value; with semicolon SAFE_LITERAL_TOKEN";`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--any", "SAFE_LITERAL_TOKEN");
  assert.equal(r.status, 0, `expected hit exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /SAFE_LITERAL_TOKEN/, "benign literal not found via content search");
  cleanup(dir);
});
