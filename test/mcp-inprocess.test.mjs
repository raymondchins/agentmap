// SPDX-License-Identifier: MIT
// ============================================================================
//  Byte-safety suite for the IN-PROCESS MCP path (mcp.mjs -> agentmap.mjs's
//  mcpQuery, parsed-once + cached). Every MCP tool call used to SPAWN
//  `node agentmap.mjs --json <flag> ...` and return its stdout verbatim; it now
//  answers in-process. This test locks the invariant that made the rewrite safe:
//  for the SAME query on the SAME repo, the MCP tool's content[0].text is
//  BYTE-IDENTICAL to the CLI's `--json` stdout -- the exact string the old spawn
//  path returned by construction. If mcpQuery ever drifts from a main() branch,
//  one of these equalities breaks.
//
//  Method: drive the real server (`agentmap --mcp`) over stdio for the 8 tools +
//  edge cases, and INDEPENDENTLY run the matching `--json` CLI command; assert
//  the two strings are equal. Both run against ONE frozen, clean, committed
//  fixture so ensureFresh() returns the identical cached map to each -- no moving
//  target. Also covers: the crash-masking contract (a build crash -> isError, not
//  a false "no results") and the parse-once cache (two calls in one session reuse
//  one parse, yet stay byte-identical to the CLI).
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, gitInit, cleanup, run } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTMAP = join(HERE, "..", "agentmap.mjs");

// A small but non-trivial fixture: a feature dir, cross-file imports (so hubs /
// relates / features / symbols all have real content), and a string literal only
// reachable via the --any git-grep content fallback.
const FIXTURE = {
  "src/util.ts": "export function greet(name: string) { return `hello ${name}`; }\nexport const VERSION = 1;\nexport class Widget {}\n",
  "src/main.ts": 'import { greet, Widget } from "./util";\nexport function run() { return greet("x") + new Widget(); }\n',
  "app/dashboard/page.ts": 'import { run } from "../../src/main";\nexport const page = run();\nexport const MAGIC_TOKEN = "zephyr-42";\n',
};

// Drive a fresh `agentmap --mcp` server in `cwd`; send the tools/call requests,
// return each response by request order. Resolves once every id-bearing response
// is seen or the process exits.
function mcpCalls(cwd, calls) {
  const requests = calls.map(([name, args], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENTMAP, "--mcp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const byId = new Map();
    let buf = "", stderr = "";
    const done = () => { try { child.kill(); } catch {} resolve(requests.map((r) => byId.get(r.id))); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined) byId.set(msg.id, msg);
        if (byId.size >= requests.length) return done();
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("exit", () => resolve(requests.map((r) => byId.get(r.id))));
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    setTimeout(() => { if (byId.size < requests.length) reject(new Error(`timeout: ${byId.size}/${requests.length}; stderr=${stderr}`)); }, 30000).unref();
  });
}

// The MCP tool name + args -> the equivalent CLI `--json` argv (mirrors the arg
// mapping mcpQuery does internally). Used ONLY to produce the byte-for-byte
// baseline; production code no longer builds argv at all.
function cliArgv(name, a) {
  switch (name) {
    case "any": return ["--any", String(a.query ?? "")];
    case "find": return ["--find", String(a.symbol ?? "")];
    case "relates": return ["--relates", String(a.path ?? "")];
    case "map": {
      const out = ["--map"];
      if (a.focus != null && String(a.focus) !== "") out.push("--focus", String(a.focus));
      if (a.tokens != null && Number.isFinite(Number(a.tokens))) out.push("--tokens", String(Math.trunc(Number(a.tokens))));
      return out;
    }
    case "hubs": return ["--hubs"];
    case "features": return ["--features"];
    case "feature": return ["--feature", String(a.name ?? "")];
    case "symbols": return a.n != null && Number.isFinite(Number(a.n)) ? ["--symbols", String(Math.trunc(Number(a.n)))] : ["--symbols"];
    default: throw new Error(`no cli mapping for ${name}`);
  }
}

// Every tool + the edge cases that exercise each distinct output KIND.
const CALLS = [
  ["any", { query: "greet" }],
  ["any", { query: "util" }],
  ["any", { query: "zephyr" }],
  ["any", { query: "zzznotfoundxyz" }],
  ["find", { symbol: "widget" }],
  ["find", { symbol: "nomatchxyz" }],
  ["relates", { path: "util.ts" }],
  ["relates", { path: "nomatchxyz" }],
  ["map", { tokens: 400 }],
  ["map", { focus: "main.ts", tokens: 300 }],
  ["map", { focus: "nomatchxyz" }],
  ["hubs", {}],
  ["features", {}],
  ["feature", { name: "dashboard" }],
  ["feature", { name: "nomatchxyz" }],
  ["symbols", { n: 5 }],
  ["symbols", {}],
];

test("in-process MCP output is byte-identical to the CLI --json output for every tool", async () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  // Warm the on-disk map once so the server and the per-call CLI runs read the
  // SAME cached clean build (identical pageranks) -- no rebuild race.
  run(dir, "--json", "--hubs");

  const mcpResponses = await mcpCalls(dir, CALLS);

  for (let i = 0; i < CALLS.length; i++) {
    const [name, args] = CALLS[i];
    const resp = mcpResponses[i];
    assert.ok(resp && resp.result, `no MCP response for ${name} ${JSON.stringify(args)}`);
    const mcpText = resp.result.content[0].text;
    assert.notEqual(resp.result.isError, true, `${name} ${JSON.stringify(args)} unexpectedly isError: ${mcpText}`);

    const cli = run(dir, "--json", ...cliArgv(name, args));
    const cliText = cli.stdout.trim();

    assert.equal(mcpText, cliText, `BYTE DRIFT on ${name} ${JSON.stringify(args)}\n  mcp: ${mcpText}\n  cli: ${cliText}`);
    const parsed = JSON.parse(mcpText);
    assert.equal(parsed.command, name, `unexpected command tag for ${name}`);
  }
  cleanup(dir);
});

test("a build crash surfaces as isError in-process, not a false 'no results'", async () => {
  const dir = makeRepo({ "a.ts": "export const a = 1;\n" });
  gitInit(dir, { commit: true });
  // Make the map's own path a dir so the atomic rename target can't be written ->
  // build() throws in-process (same forcing trick as mcp-protocol.test.mjs).
  mkdirSync(join(dir, ".claude", "agentmap", "map.json"), { recursive: true });
  const [call] = await mcpCalls(dir, [["any", { query: "a" }]]);
  assert.equal(call.result.isError, true, "a hard crash was masked as a successful answer");
  assert.doesNotMatch(call.result.content[0].text, /^no results$/, "crash returned the literal 'no results'");
  assert.doesNotMatch(call.result.content[0].text, /^\{/, "a crash must not emit a query JSON object");
  cleanup(dir);
});

test("the parse-once cache serves repeat calls without drifting from the CLI", async () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  run(dir, "--json", "--hubs");

  // Two DIFFERENT tools in ONE server session (second reuses the first call's
  // in-memory parse) must still each equal their CLI baseline.
  const [hubsResp, symsResp] = await mcpCalls(dir, [["hubs", {}], ["symbols", { n: 3 }]]);
  const hubsCli = run(dir, "--json", "--hubs").stdout.trim();
  const symsCli = run(dir, "--json", "--symbols", "3").stdout.trim();
  assert.equal(hubsResp.result.content[0].text, hubsCli, "hubs drifted from CLI under the parse-once cache");
  assert.equal(symsResp.result.content[0].text, symsCli, "symbols drifted from CLI under the parse-once cache");
  cleanup(dir);
});

test("an empty required arg is a usage error (isError), matching the CLI's exit 2", async () => {
  const dir = makeRepo({ "a.ts": "export const a = 1;\n" });
  gitInit(dir, { commit: true });
  const [call] = await mcpCalls(dir, [["any", { query: "" }]]);
  assert.equal(call.result.isError, true, "empty --any query must be a usage error");
  const cli = run(dir, "--json", "--any", "");
  assert.equal(call.result.content[0].text, cli.stderr.trim(), "usage message drifted from the CLI's stderr");
  cleanup(dir);
});
