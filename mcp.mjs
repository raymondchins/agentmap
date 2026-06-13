#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// ============================================================================
//  agentmap — stdio MCP (Model Context Protocol) server.
//
//  Exposes the agentmap repo-map as first-class MCP tools so any MCP client
//  (Cursor, Cline, Claude Desktop, …) can query a TS/JS codebase. Launched by
//  `agentmap --mcp` (agentmap.mjs dynamically imports this file + calls serve()).
//
//  Transport: JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout — the
//  simplest MCP stdio transport (one JSON object per line each way).
//
//  Each tool is implemented by SPAWNING the agentmap CLI in `--json` mode
//  (`node agentmap.mjs --json <flag> <args…>`), capturing its single-object
//  stdout, and returning it verbatim. This file depends ONLY on the documented
//  --json CLI surface — never on agentmap.mjs internals. Node stdlib only.
// ============================================================================
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = "2024-11-05";
// agentmap.mjs lives next to this file; run it as a subprocess for every tool.
const AGENTMAP = fileURLToPath(new URL("./agentmap.mjs", import.meta.url));

// Server version = package.json version (resolve relative to this file, not cwd).
function pkgVersion() {
  try {
    const p = fileURLToPath(new URL("./package.json", import.meta.url));
    return JSON.parse(readFileSync(p, "utf8")).version || "0.0.0";
  } catch { return "0.0.0"; }
}

// ---------------------------------------------------------------------------
// Tool registry. Each entry: an MCP inputSchema + a fn mapping the call's
// args → the agentmap CLI argv (always `--json` first so stdout is one object).
// ---------------------------------------------------------------------------
const str = (description) => ({ type: "string", description });
const TOOLS = [
  {
    name: "any",
    description:
      "Unified router: resolve a query against the repo map (file → symbol → feature) then fall back to a live git-grep for string/copy/data literals. Best default for 'where is X' / reuse-before-rebuild.",
    inputSchema: { type: "object", properties: { query: str("File path, symbol name, feature name, or any literal string to search for.") }, required: ["query"] },
    argv: (a) => ["--any", String(a.query ?? "")],
  },
  {
    name: "find",
    description: "Find every exported symbol whose name matches (substring, case-insensitive). Use to locate a function/class/type before rebuilding it.",
    inputSchema: { type: "object", properties: { symbol: str("Symbol name or substring to match against exports.") }, required: ["symbol"] },
    argv: (a) => ["--find", String(a.symbol ?? "")],
  },
  {
    name: "relates",
    description: "Blast radius for a file: its exports, imports, direct dependents, and the files most related to it by random-walk relevance. Use before editing to see who breaks.",
    inputSchema: { type: "object", properties: { path: str("File path, basename, or unique substring identifying the target file.") }, required: ["path"] },
    argv: (a) => ["--relates", String(a.path ?? "")],
  },
  {
    name: "map",
    description: "Token-budgeted ranked digest of the codebase (PageRank + Aider-style symbol ranking). Optionally focus toward a file and/or set a token budget.",
    inputSchema: {
      type: "object",
      properties: {
        focus: str("Optional file path/substring to personalize the ranking toward."),
        tokens: { type: "integer", description: "Optional token budget for the digest (default 8192 global / 1024 focused)." },
      },
    },
    // --map takes optional --focus and --tokens; only pass what's provided.
    argv: (a) => {
      const out = ["--map"];
      if (a.focus != null && String(a.focus) !== "") out.push("--focus", String(a.focus));
      if (a.tokens != null && Number.isFinite(Number(a.tokens))) out.push("--tokens", String(Math.trunc(Number(a.tokens))));
      return out;
    },
  },
  {
    name: "hubs",
    description: "List the most important files in the repo by PageRank (the hubs everything imports). Read these first to understand a codebase.",
    inputSchema: { type: "object", properties: {} },
    argv: () => ["--hubs"],
  },
  {
    name: "features",
    description: "List every detected feature (top-level app/ route segment) with its file count.",
    inputSchema: { type: "object", properties: {} },
    argv: () => ["--features"],
  },
  {
    name: "feature",
    description: "List all files belonging to a named feature plus its external dependents.",
    inputSchema: { type: "object", properties: { name: str("Feature name (run the 'features' tool to list them).") }, required: ["name"] },
    argv: (a) => ["--feature", String(a.name ?? "")],
  },
  {
    name: "symbols",
    description: "Top N globally ranked symbols (Aider-style importance). Defaults to 30.",
    inputSchema: { type: "object", properties: { n: { type: "integer", description: "How many symbols to return (default 30)." } } },
    // --symbols takes an optional positional count.
    argv: (a) => (a.n != null && Number.isFinite(Number(a.n)) ? ["--symbols", String(Math.trunc(Number(a.n)))] : ["--symbols"]),
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
// MCP tools/list wants only the public fields (no internal argv builder).
const toolList = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

// Spawn `node agentmap.mjs --json <flag> <args…>` in the client's cwd, resolve
// with stdout. Rejects (with stderr/message) only on spawn failure; a non-zero
// exit still resolves so the dispatcher can surface stdout/stderr as isError.
function runAgentmap(extraArgv) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [AGENTMAP, "--json", ...extraArgv],
      { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, stdout: (stdout || "").trim(), stderr: (stderr || "").trim(), spawnError: err && err.code === undefined ? err.message : "" });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing. Write one compact JSON object per line to stdout.
// ---------------------------------------------------------------------------
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
const result = (id, r) => send({ jsonrpc: "2.0", id, result: r });
const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

// Dispatch a tools/call: build argv, run the CLI, wrap stdout as MCP content.
async function callTool(name, rawArgs) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  const argv = tool.argv(rawArgs && typeof rawArgs === "object" ? rawArgs : {});
  const { code, stdout, stderr, spawnError } = await runAgentmap(argv);
  if (spawnError) return { content: [{ type: "text", text: `failed to launch agentmap: ${spawnError}` }], isError: true };
  // Exit 1 = query returned zero results (a valid answer, not a tool failure):
  // surface stdout when present, else a friendly empty note. Exit ≥2 = real
  // error → mark isError and prefer stderr.
  if (code >= 2) return { content: [{ type: "text", text: stderr || stdout || `agentmap exited ${code}` }], isError: true };
  const text = stdout || (code === 1 ? `no results` : stderr) || "";
  return { content: [{ type: "text", text }] };
}

// Handle one parsed JSON-RPC request object. Notifications (no `id`) get no
// reply per the spec; everything else returns a result or an error.
async function handle(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize":
      return result(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "agentmap", version: pkgVersion() } });
    case "notifications/initialized":
    case "initialized":
      return; // notification — no response
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: toolList() });
    case "tools/call": {
      const name = params && params.name;
      const out = await callTool(name, params && params.arguments);
      return result(id, out);
    }
    default:
      if (isNotification) return; // ignore unknown notifications silently
      return error(id, -32601, `method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// serve() — read newline-delimited JSON from stdin, dispatch each complete
// line. Never crash on a malformed line: reply with a JSON-RPC parse error
// (-32700) when we can, otherwise skip it. Lines are processed sequentially so
// responses stay ordered.
// ---------------------------------------------------------------------------
export async function serve() {
  process.stdin.setEncoding("utf8");
  let buf = "";
  let chain = Promise.resolve(); // serialize handling so output order is stable

  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { error(null, -32700, "parse error"); continue; }
      // batch requests (array) are valid JSON-RPC — handle each element
      const msgs = Array.isArray(msg) ? msg : [msg];
      for (const m of msgs) chain = chain.then(() => handle(m)).catch((e) => error(m && m.id != null ? m.id : null, -32603, String(e && e.message || e)));
    }
  });
  // keep the process alive until stdin closes
  await new Promise((resolve) => process.stdin.on("end", resolve));
  await chain;
}

// Run directly (`node mcp.mjs`) as well as when imported + invoked via --mcp.
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])) {
  serve();
}
