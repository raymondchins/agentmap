// SPDX-License-Identifier: MIT
// Contract #9 — agentmap-nudge.mjs hook behaviour.
//
// The nudge hook is a standalone Node script: it reads a JSON payload from
// stdin and writes a JSON `hookSpecificOutput` object to stdout when it decides
// to fire, or nothing when it stays silent. It always exits 0.
//
// This suite drives the hook directly as a subprocess (same as Claude Code
// would), covering:
//   - Grep tool: fires / stays silent
//   - Bash tool: fires on primary searcher + matching pattern / stays silent
//     on pipes, Tailwind-class searches, and lowercase HTML tags
//   - PascalCase symbol hunt (Bash only): fires on multi-hump identifiers
//   - Injection safety: malformed/dangerous input never crashes, never leaks
//   - Exit-0 guarantee on every path
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "hooks", "agentmap-nudge.mjs");

// Drive the hook: feed `payload` as JSON on stdin, return { stdout, status }.
function runHook(payload) {
  const input = JSON.stringify(payload);
  try {
    const stdout = execFileSync(process.execPath, [HOOK], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? "",
      status: typeof e.status === "number" ? e.status : 1,
    };
  }
}

// Helper: assert the hook fired (emitted hookSpecificOutput).
function assertFires(result, label) {
  assert.equal(result.status, 0, `${label}: expected exit 0, got ${result.status}`);
  assert.ok(result.stdout.length > 0, `${label}: expected output, got silence`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(
    parsed?.hookSpecificOutput?.additionalContext?.length > 0,
    `${label}: hookSpecificOutput.additionalContext missing or empty`,
  );
}

// Helper: assert the hook stayed silent (no stdout, exit 0).
function assertSilent(result, label) {
  assert.equal(result.status, 0, `${label}: expected exit 0, got ${result.status}`);
  assert.equal(result.stdout, "", `${label}: expected silence, got: ${result.stdout.slice(0, 200)}`);
}

// ─── Grep tool ───────────────────────────────────────────────────────────────

test("Grep: fires on import pattern", () => {
  assertFires(
    runHook({ tool_name: "Grep", tool_input: { pattern: "import { Button }" } }),
    "Grep import pattern",
  );
});

test("Grep: fires on from '...' pattern", () => {
  assertFires(
    runHook({ tool_name: "Grep", tool_input: { pattern: "from '@/components'" } }),
    "Grep from pattern",
  );
});

test("Grep: fires on JSX component open tag", () => {
  assertFires(
    runHook({ tool_name: "Grep", tool_input: { pattern: "<Hero" } }),
    "Grep JSX component tag",
  );
});

test("Grep: fires on <ProviderCard tag", () => {
  assertFires(
    runHook({ tool_name: "Grep", tool_input: { pattern: "<ProviderCard" } }),
    "Grep PascalCase component tag",
  );
});

test("Grep: fires on 'where is' intent", () => {
  assertFires(
    runHook({ tool_name: "Grep", tool_input: { pattern: "where is the auth hook" } }),
    "Grep where-is intent",
  );
});

test("Grep: stays silent on Tailwind class", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "bg-white" } }),
    "Grep Tailwind class",
  );
});

test("Grep: stays silent on lowercase HTML tag", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "<div" } }),
    "Grep lowercase HTML tag",
  );
});

test("Grep: stays silent on plain text search", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "Hello World" } }),
    "Grep plain text",
  );
});

test("Grep: stays silent on TS generic denylist (<Promise<)", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "<Promise<" } }),
    "Grep TS generic denylist",
  );
});

test("Grep: stays silent on TS generic mid-pattern (useState<Promise>)", () => {
  // Generic sits mid-pattern, not at start — denylist must still suppress it.
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "useState<Promise>" } }),
    "Grep TS generic mid-pattern",
  );
});

test("Grep: exits 0 with empty output on empty pattern", () => {
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "" } }),
    "Grep empty pattern",
  );
});

// ─── Bash tool — fires ───────────────────────────────────────────────────────

test("Bash: fires on rg <PascalCase symbol> (symbol hunt)", () => {
  assertFires(
    runHook({ tool_name: "Bash", tool_input: { command: "rg ProviderCard src/" } }),
    "Bash rg PascalCase symbol",
  );
});

test("Bash: fires on grep import pattern", () => {
  assertFires(
    runHook({ tool_name: "Bash", tool_input: { command: 'grep -rn "import { Button }" src/' } }),
    "Bash grep import",
  );
});

test("Bash: fires on rg JSX component tag <Hero", () => {
  assertFires(
    runHook({ tool_name: "Bash", tool_input: { command: 'rg "<Hero" .' } }),
    "Bash rg JSX tag",
  );
});

test("Bash: fires on primary grep after semicolon", () => {
  assertFires(
    runHook({ tool_name: "Bash", tool_input: { command: "cd src; grep -r TopProviders ." } }),
    "Bash grep after semicolon",
  );
});

test("Bash: fires on primary grep after &&", () => {
  assertFires(
    runHook({ tool_name: "Bash", tool_input: { command: "cd src && rg ProviderCard" } }),
    "Bash rg after &&",
  );
});

test("Bash: fires on egrep with import", () => {
  assertFires(
    runHook({ tool_name: "Bash", tool_input: { command: 'egrep -r "import.*AuthProvider" .' } }),
    "Bash egrep import",
  );
});

test("Bash: fires on ag with component tag", () => {
  assertFires(
    runHook({ tool_name: "Bash", tool_input: { command: 'ag "<AuthProvider" src/' } }),
    "Bash ag JSX tag",
  );
});

// ─── Bash tool — stays silent ────────────────────────────────────────────────

test("Bash: stays silent on pipe-filtered grep (log filtering)", () => {
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "ps aux | grep node" } }),
    "Bash pipe grep",
  );
});

test("Bash: stays silent on piped rg (grep SomeError pattern)", () => {
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "cat logs.txt | rg SomeError" } }),
    "Bash pipe rg",
  );
});

test("Bash: stays silent on Tailwind class search", () => {
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "rg bg-white src/" } }),
    "Bash rg Tailwind class",
  );
});

test("Bash: stays silent on TS generic mid-command (rg \"<Promise<Foo>\")", () => {
  // Regression: denylist is no longer ^-anchored, so it suppresses the generic
  // even though it appears mid-command rather than at the pattern start.
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: 'rg "<Promise<Foo>" src/' } }),
    "Bash TS generic mid-command",
  );
});

test("Bash: stays silent on non-searcher command", () => {
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "cat package.json" } }),
    "Bash cat command",
  );
});

test("Bash: stays silent on npm command", () => {
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "npm run build" } }),
    "Bash npm command",
  );
});

test("Bash: stays silent on git command", () => {
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "git log --oneline" } }),
    "Bash git command",
  );
});

test("Bash: stays silent on single-hump PascalCase (Button, Error)", () => {
  // Single-hump PascalCase should NOT fire — too noisy (Button, Error, etc.)
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "rg Button src/" } }),
    "Bash single-hump PascalCase",
  );
});

test("Bash: stays silent on all-caps word (TODO, API)", () => {
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "rg TODO src/" } }),
    "Bash all-caps word",
  );
});

// ─── Unknown / other tools — stay silent ─────────────────────────────────────

test("unknown tool: stays silent and exits 0", () => {
  assertSilent(
    runHook({ tool_name: "Read", tool_input: { file_path: "src/index.ts" } }),
    "Read tool",
  );
});

test("Write tool: stays silent and exits 0", () => {
  assertSilent(
    runHook({ tool_name: "Write", tool_input: { file_path: "out.ts", content: "export {}" } }),
    "Write tool",
  );
});

// ─── Output shape ─────────────────────────────────────────────────────────────

test("fired output: hookEventName is PreToolUse", () => {
  const r = runHook({ tool_name: "Grep", tool_input: { pattern: "import" } });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(
    parsed?.hookSpecificOutput?.hookEventName,
    "PreToolUse",
    "hookEventName must be PreToolUse",
  );
});

test("fired output: message mentions agentmap and --any", () => {
  const r = runHook({ tool_name: "Bash", tool_input: { command: "rg ProviderCard src/" } });
  const msg = JSON.parse(r.stdout)?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(msg, /agentmap/, "message should mention agentmap");
  assert.match(msg, /--any/, "message should mention --any");
});

// ─── Injection safety ─────────────────────────────────────────────────────────

test("injection safety: grep shell metacharacter in command — no crash, exit 0", () => {
  const r = runHook({
    tool_name: "Bash",
    tool_input: { command: 'grep "$(rm -rf /)" src/' },
  });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  // Pattern contains import-like words? No. Just assert no crash and output is
  // either empty or valid JSON (never a raw error dump).
  if (r.stdout.length > 0) {
    assert.doesNotThrow(() => JSON.parse(r.stdout), "stdout must be valid JSON when non-empty");
  }
});

test("injection safety: empty JSON payload — no crash, exit 0", () => {
  assertSilent(runHook({}), "empty payload");
});

test("injection safety: null tool_input — no crash, exit 0", () => {
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: null }),
    "null tool_input",
  );
});

test("injection safety: oversized Grep pattern — silent, exit 0", () => {
  // Patterns longer than 2000 chars skip nudging (belt-and-suspenders guard).
  assertSilent(
    runHook({ tool_name: "Grep", tool_input: { pattern: "import ".repeat(400) } }),
    "oversized Grep pattern",
  );
});

test("always exits 0: malformed JSON on stdin — silent, exit 0", () => {
  // Send raw non-JSON bytes; the hook must swallow the parse error and exit 0.
  try {
    execFileSync(process.execPath, [HOOK], {
      input: "NOT JSON {{{{",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // exit 0 — good, stdout is already captured above
  } catch (e) {
    // execFileSync throws on non-zero exit — that would be a failure.
    assert.fail(`hook exited non-zero (${e.status}) on malformed stdin: ${e.stderr}`);
  }
});

// ─── Data-file target guard (false-positive prevention) ───────────────────────

test("Bash: stays silent on 'rg TypeError app.log' (exception name in log file)", () => {
  // SYMBOL_RE would match TypeError (multi-hump), but target is a .log file —
  // this is log-filtering, not a symbol hunt. Must stay silent.
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "rg TypeError app.log" } }),
    "rg TypeError app.log",
  );
});

test("Bash: stays silent on 'grep -rn ValueError logs/run.txt' (exception in .txt file)", () => {
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "grep -rn ValueError logs/run.txt" } }),
    "grep ValueError .txt",
  );
});

test("Bash: still fires on 'rg SomeSymbol src/foo.ts' (source-file target)", () => {
  // .ts is a source file — guard must NOT suppress this, SYMBOL_RE fires normally.
  assertFires(
    runHook({ tool_name: "Bash", tool_input: { command: "rg SomeSymbol src/foo.ts" } }),
    "rg SomeSymbol src/foo.ts",
  );
});

test("Bash: stays silent on 'rg Foo data.json' (symbol-like name in JSON data file)", () => {
  // .json is a data file — even though 'Foo' could look like a single-hump
  // symbol (doesn't match SYMBOL_RE anyway), the data-file guard ensures silence.
  // Using a multi-hump name to be explicit: FooBar in a .json file.
  assertSilent(
    runHook({ tool_name: "Bash", tool_input: { command: "rg FooBar data.json" } }),
    "rg FooBar data.json",
  );
});
