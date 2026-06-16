// SPDX-License-Identifier: MIT
// Regression: parseSettings must tolerate trailing commas in JSONC settings.
//
// Background: v0.4.0 made `.claude/settings.json` JSONC-tolerant (comments
// accepted via stripJsonComments). Real-world JSONC editors — VS Code's JSONC
// mode, JetBrains' "JSON with comments" — also allow trailing commas, and
// users routinely write `{ "a": 1, }` or `[1, 2,]`. Strict JSON.parse rejects
// those, so the original stripJsonComments-only retry still threw, surfacing
// ".claude/settings.json is not valid JSON" and blocking --install-hooks /
// --hook-status / --doctor for any user whose settings.json has a trailing
// comma.
//
// Coverage here pins JSONC trailing-comma tolerance across every project-local
// parseSettings call site (--install-hooks, --hook-status, --doctor) and
// verifies the state machine is string-literal- and comment-aware.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const TS_FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
  "src/index.ts": `export function x() { return 1; }`,
};

// Run --install-hooks against a repo whose .claude/settings.json carries the
// given body. Returns { dir, r }.
function installHooksWithSettings(settingsBody, extraFiles = {}) {
  const dir = makeRepo({ ...TS_FIXTURE, ...extraFiles, ".claude/settings.json": settingsBody });
  gitInit(dir, { commit: true });
  const r = run(dir, "--install-hooks");
  return { dir, r };
}

test("trailing comma in object is tolerated (VS Code JSONC default)", () => {
  // The exact pattern VS Code's JSONC formatter writes: trailing comma after
  // the final key in an object. Strict JSON.parse rejects this.
  const { dir, r } = installHooksWithSettings(`{
  "permissions": { "deny": ["Bash(rm -rf *)"] },
  "hooks": { "PreToolUse": [], }
}
`);
  assert.equal(r.status, 0, `object trailing comma broke --install-hooks: ${r.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.permissions.deny, ["Bash(rm -rf *)"], "existing permissions clobbered");
  assert.ok(s.hooks.PreToolUse.some((e) => e.matcher === "Grep"), "Grep nudge not wired");
  cleanup(dir);
});

test("trailing comma in array is tolerated", () => {
  const { dir, r } = installHooksWithSettings(`{
  "permissions": { "deny": ["Bash(rm -rf *)",] },
  "hooks": { "PreToolUse": [] }
}
`);
  assert.equal(r.status, 0, `array trailing comma broke --install-hooks: ${r.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.permissions.deny, ["Bash(rm -rf *)"], "array with trailing comma mis-parsed");
  cleanup(dir);
});

test("trailing comma in deeply nested structures is tolerated", () => {
  const { dir, r } = installHooksWithSettings(`{
  "permissions": {
    "allow": ["Bash(git status:*)",],
    "deny": ["Bash(rm -rf *)",],
  },
  "linter": {
    "rules": {
      "strict": [1, 2, 3,],
    },
  },
}
`);
  assert.equal(r.status, 0, `nested trailing commas broke --install-hooks: ${r.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.permissions.allow, ["Bash(git status:*)"], "nested array trailing comma mis-parsed");
  assert.deepEqual(s.linter.rules.strict, [1, 2, 3], "deeply nested array trailing comma mis-parsed");
  cleanup(dir);
});

test("trailing commas combined with comments (full JSONC) is tolerated", () => {
  // The original 0.4.0 fix handled comments; trailing commas must compose.
  const { dir, r } = installHooksWithSettings(`{
  // user-edited permission grant
  "permissions": { "deny": ["Bash(rm -rf *)" /* deny */ ,] },
  "hooks": { "PreToolUse": [] }
}
`);
  assert.equal(r.status, 0, `JSONC comments + trailing commas broke --install-hooks: ${r.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.permissions.deny, ["Bash(rm -rf *)"], "JSONC combo mis-parsed");
  cleanup(dir);
});

test("trailing comma INSIDE a string literal is preserved (not stripped)", () => {
  // A comma that is part of a string value — e.g. a command list or a
  // sentence — must not be touched. The state machine must track string
  // context so trailing-comma stripping does not corrupt string contents.
  const { dir, r } = installHooksWithSettings(`{
  "permissions": { "deny": ["Bash(echo a,b,)"] },
  "hint": "a,b,c,",
}
`);
  assert.equal(r.status, 0, `string-internal commas broke --install-hooks: ${r.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.equal(s.hint, "a,b,c,", "trailing comma inside string value was wrongly stripped");
  assert.deepEqual(s.permissions.deny, ["Bash(echo a,b,)"], "string-internal commas mangled");
  cleanup(dir);
});

test("trailing comma inside an escaped-string sequence is preserved", () => {
  // Tricky: a string containing `\",` — the comma follows an escaped quote
  // and must remain part of the string, not be treated as a value separator.
  const { dir, r } = installHooksWithSettings(`{
  "msg": "he said \\"hi\\", then left",
  "hooks": { "PreToolUse": [] },
}
`);
  assert.equal(r.status, 0, `escaped-string trailing comma broke --install-hooks: ${r.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.equal(s.msg, 'he said "hi", then left', "escaped-quote string mis-parsed");
  cleanup(dir);
});

test("multi-line array with trailing comma after the last item is tolerated", () => {
  // The pattern users actually write — one comma per item, trailing on the last.
  const { dir, r } = installHooksWithSettings(`{
  "tags": [
    "alpha",
    "beta",
    "gamma",
  ],
}
`);
  assert.equal(r.status, 0, `multi-line trailing comma broke --install-hooks: ${r.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.tags, ["alpha", "beta", "gamma"], "multi-line array mis-parsed");
  cleanup(dir);
});

test("--hook-status reads JSONC-with-trailing-commas settings without flagging invalid", () => {
  // hookStatus wraps parseSettings in try/catch and surfaces an "invalid"
  // marker when it throws. After the fix, trailing commas must NOT set that.
  const dir = makeRepo({
    ...TS_FIXTURE,
    ".claude/settings.json": `{
      "hooks": { "PreToolUse": [{ "matcher": "Grep", "hooks": [], }] },
    }`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--hook-status");
  assert.equal(r.status, 0, `--hook-status failed on JSONC trailing comma: ${r.stderr}`);
  assert.doesNotMatch(r.stdout + r.stderr, /invalid|not valid JSON/i,
    "JSONC trailing comma flagged as invalid settings");
  cleanup(dir);
});

test("--doctor does not flag JSONC-with-trailing-commas settings as invalid", () => {
  const dir = makeRepo({
    ...TS_FIXTURE,
    ".claude/settings.json": `{
      "hooks": { "PreToolUse": [{ "matcher": "Grep", "hooks": [], }] },
    }`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--doctor");
  assert.equal(r.status, 0, `--doctor failed on JSONC trailing comma: ${r.stderr}`);
  // collectHookStatus() sets status="invalid", detail="not wired (invalid settings.json)"
  // when parseSettings throws. After the fix it must not surface that marker.
  assert.doesNotMatch(r.stdout + r.stderr, /invalid settings\.json/i,
    "JSONC trailing comma flagged as invalid by doctor");
  cleanup(dir);
});

test("commas inside a line comment are not seen by the trailing-comma pass", () => {
  // A `,` that lives inside a `// line` comment is part of the comment, not
  // JSON syntax. stripJsonComments removes the whole comment first, so by the
  // time the trailing-comma pass runs there is no comma there to find. Pins
  // that the two passes compose safely.
  const { dir, r } = installHooksWithSettings(`{
  // trailing, comma, in, comment,
  "hooks": { "PreToolUse": [] }
}
`);
  assert.equal(r.status, 0, `comment-internal commas broke --install-hooks: ${r.stderr}`);
  cleanup(dir);
});

test("idempotent re-run after user reintroduces trailing commas", () => {
  // Scenario: user runs --install-hooks once (succeeds, writes strict JSON),
  // then their editor reformats settings.json and reintroduces trailing
  // commas, then they run --install-hooks again. Second run must still succeed
  // AND must preserve the agentmap nudge wired by the first run.
  const dir = makeRepo({
    ...TS_FIXTURE,
    ".claude/settings.json": `{
      "permissions": { "deny": ["Bash(rm -rf *)",] },
    }`,
  });
  gitInit(dir, { commit: true });
  assert.equal(run(dir, "--install-hooks").status, 0, "first install failed");
  // Simulate the user's editor reformatting: rewrite the file with a trailing
  // comma on the PreToolUse array's final element. Use the post-install
  // permissions shape so we don't accidentally clobber the nudge.
  writeFileSync(join(dir, ".claude", "settings.json"), `{
    "permissions": { "deny": ["Bash(rm -rf *)",] },
    "hooks": {
      "PreToolUse": [
        { "matcher": "Grep", "hooks": [{ "type": "command", "command": "node x" }] },
        { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node x" },] },
      ]
    },
  }`);
  const r2 = run(dir, "--install-hooks");
  assert.equal(r2.status, 0, `idempotent re-run failed after user reintroduced trailing comma: ${r2.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.ok(s.hooks.PreToolUse.some((e) => e.matcher === "Grep"), "Grep nudge lost on re-run");
  assert.ok(s.hooks.PreToolUse.some((e) => e.matcher === "Bash"), "Bash nudge lost on re-run");
  cleanup(dir);
});

test("only trailing commas are stripped — interior commas in arrays/objects stay", () => {
  // Guard against an over-eager strip: a comma between two elements is NOT a
  // trailing comma and must be preserved. We use an array of two strings to
  // verify: removing the inter-element comma would collapse the array.
  const { dir, r } = installHooksWithSettings(`{
  "tags": ["alpha", "beta",],
}
`);
  assert.equal(r.status, 0, `normal-with-trailing broke --install-hooks: ${r.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.tags, ["alpha", "beta"], "inter-element comma was wrongly stripped");
  cleanup(dir);
});

test("trailing comma after a numeric literal is tolerated", () => {
  // Numbers don't have the surrounding context strings do — a `,` after `3`
  // before `]` is a trailing comma.
  const { dir, r } = installHooksWithSettings(`{
  "ports": [3000, 3001, 3002,],
}
`);
  assert.equal(r.status, 0, `numeric trailing comma broke --install-hooks: ${r.stderr}`);
  const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(s.ports, [3000, 3001, 3002], "numeric array mis-parsed");
  cleanup(dir);
});

test("genuinely malformed JSON (not just trailing commas) still errors clearly", () => {
  // Negative control: a missing closing brace is NOT a trailing comma, must
  // still surface the caller's clear "not valid JSON" error so users don't
  // lose signal after the fix.
  const dir = makeRepo({
    ...TS_FIXTURE,
    ".claude/settings.json": `{ "hooks": { "PreToolUse": [ `,  // missing close
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--install-hooks");
  assert.equal(r.status, 1, `expected exit 1 on genuinely malformed JSON, got ${r.status}`);
  assert.match(r.stderr, /not valid JSON/i, "expected clear 'not valid JSON' error for malformed input");
  cleanup(dir);
});

// Negative controls: leading / double commas are NOT trailing commas and must
// still surface as parse errors. JSONC tolerates only TRAILING commas — never
// leading or empty-element commas. Silent acceptance of `{,}` / `[1,,]` would
// wipe a user's settings without warning (e.g. after a botched merge).
test("leading comma in object ({,}) is rejected — not silently collapsed to {}", () => {
  const dir = makeRepo({ ...TS_FIXTURE, ".claude/settings.json": `{,}` });
  gitInit(dir, { commit: true });
  const r = run(dir, "--install-hooks");
  assert.equal(r.status, 1, `expected exit 1 on {,}, got ${r.status}`);
  assert.match(r.stderr, /not valid JSON/i, "leading comma silently accepted");
  cleanup(dir);
});

test("leading comma in array ([,]) is rejected — not silently collapsed to []", () => {
  const dir = makeRepo({ ...TS_FIXTURE, ".claude/settings.json": `[,]` });
  gitInit(dir, { commit: true });
  const r = run(dir, "--install-hooks");
  assert.equal(r.status, 1, `expected exit 1 on [,], got ${r.status}`);
  assert.match(r.stderr, /not valid JSON/i, "leading comma silently accepted");
  cleanup(dir);
});

test("double comma ([1,,]) is rejected — not silently collapsed to [1]", () => {
  const dir = makeRepo({ ...TS_FIXTURE, ".claude/settings.json": `[1,,]` });
  gitInit(dir, { commit: true });
  const r = run(dir, "--install-hooks");
  assert.equal(r.status, 1, `expected exit 1 on [1,,], got ${r.status}`);
  assert.match(r.stderr, /not valid JSON/i, "double comma silently accepted");
  cleanup(dir);
});

test("object with only leading comma + trailing comma ({,}) still rejected", () => {
  // `{,}` has a leading comma that happens to also be "followed by `}`".
  // Verify the bad-prev guard catches it (lastSig = `{`).
  const dir = makeRepo({
    ...TS_FIXTURE,
    ".claude/settings.json": `{ "hooks": { "PreToolUse": {,} } }`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--install-hooks");
  assert.equal(r.status, 1, `expected exit 1 on {,} nested, got ${r.status}`);
  cleanup(dir);
});
