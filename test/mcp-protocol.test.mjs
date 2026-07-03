// SPDX-License-Identifier: MIT
// Protocol-level tests for mcp.mjs — the stdio JSON-RPC server had zero test
// coverage. Drives the real server as a subprocess (spawn `agentmap --mcp`),
// writes newline-delimited JSON-RPC to stdin, and reads the replies. The
// load-bearing case: a CLI crash must surface as isError, not a false
// "no results" answer (exit code 1 is overloaded).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, gitInit, cleanup } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENTMAP = join(HERE, "..", "agentmap.mjs");

// Send a batch of JSON-RPC requests to a fresh server in `cwd`, collect the
// replies (one JSON object per output line), resolve when we've seen `expect`
// responses (those carrying an id) or the process exits.
function rpc(cwd, requests, expect) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENTMAP, "--mcp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const responses = [];
    let buf = "", stderr = "";
    const done = () => { try { child.kill(); } catch {} resolve(responses); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined) responses.push(msg);
        if (responses.length >= expect) return done();
      }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("exit", () => resolve(responses));
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    // unref so a pending timer never keeps the test's event loop alive after
    // we've already resolved (done() kills the child but not this timer).
    setTimeout(() => { if (responses.length < expect) reject(new Error(`timeout: got ${responses.length}/${expect} responses; stderr=${stderr}`)); }, 20000).unref();
  });
}

test("initialize + tools/list return the server info and the tool set", async () => {
  const dir = makeRepo({ "a.ts": "export const a = 1;\n" });
  gitInit(dir, { commit: true });
  const [init, list] = await rpc(dir, [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ], 2);
  assert.equal(init.result.serverInfo.name, "agentmap");
  assert.ok(Array.isArray(list.result.tools) && list.result.tools.length >= 8, "expected the query tools to be listed");
  const names = list.result.tools.map((t) => t.name);
  for (const n of ["any", "find", "relates", "map", "hubs", "features", "feature", "symbols"]) {
    assert.ok(names.includes(n), `tools/list missing "${n}"`);
  }
  cleanup(dir);
});

test("a genuine zero-result query is a normal answer, not isError", async () => {
  const dir = makeRepo({ "a.ts": "export const a = 1;\n" });
  gitInit(dir, { commit: true });
  const [call] = await rpc(dir, [
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "any", arguments: { query: "zzzznotfoundxyz" } } },
  ], 1);
  assert.notEqual(call.result.isError, true, "zero results must not be reported as a tool error");
  assert.ok(call.result.content[0].text.length > 0, "expected some answer text for an empty query");
  cleanup(dir);
});

test("a CLI crash is surfaced as isError, not a false 'no results'", async () => {
  const dir = makeRepo({ "a.ts": "export const a = 1;\n" });
  gitInit(dir, { commit: true });
  // Force build() to crash: make the map's own path a directory so the atomic
  // rename target can't be written (exit 1, empty stdout, stack on stderr).
  mkdirSync(join(dir, ".claude", "agentmap", "map.json"), { recursive: true });
  const [call] = await rpc(dir, [
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "any", arguments: { query: "foo" } } },
  ], 1);
  assert.equal(call.result.isError, true, "a hard crash was masked as a successful answer");
  assert.doesNotMatch(call.result.content[0].text, /^no results$/, "crash returned the literal 'no results'");
  cleanup(dir);
});
