// The bin path — the ONLY way most users ever invoke agentmap.
//
// npm installs the package's `bin` as a symlink:
//   node_modules/.bin/agentmap -> ../@raymondchins/agentmap/agentmap.mjs
// so argv[1] is the LINK while import.meta.url is the TARGET. The entry guard
// used to string-compare the two, concluded "imported, not run", and skipped
// main() — leaving `npx @raymondchins/agentmap`, `npm run agentmap`,
// `--install-hooks` and the MCP Registry's `--mcp` launch printing NOTHING and
// exiting 0 from v0.12.1 through v0.16.0. Every test until now invoked
// `node <abs path to agentmap.mjs>` directly, which is the one form that
// happened to work, so 356 green tests said nothing about the shipped command.
//
// These tests run through a real symlink. Exit 0 is NOT sufficient here — the
// bug's signature was exit 0 with empty stdout, so every assertion checks OUTPUT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { symlinkSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, gitInit, cleanup, AGENTMAP } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP = join(HERE, "..", "mcp.mjs");
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const FIXTURE = {
  "src/a.ts": "export const a = 1;\n",
  "src/b.ts": "import { a } from './a';\nexport const b = a + 1;\n",
};

// Mirror npm's layout: a .bin/ symlink pointing at the package entry point.
function linkBin(dir, target, name) {
  const binDir = join(dir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, name);
  symlinkSync(target, link);
  return link;
}

test("bin symlink: --version prints the version (not silent exit 0)", () => {
  const dir = makeRepo(FIXTURE);
  try {
    gitInit(dir, { commit: true });
    const link = linkBin(dir, AGENTMAP, "agentmap");
    const stdout = execFileSync(process.execPath, [link, "--version"], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    });
    assert.notEqual(stdout.trim(), "", "invoked via bin symlink, agentmap printed NOTHING — the entry guard skipped main()");
    assert.ok(stdout.trim().includes(PKG.version), `expected version ${PKG.version}, got: ${stdout.trim()}`);
  } finally { cleanup(dir); }
});

test("bin symlink: a query command produces real output", () => {
  const dir = makeRepo(FIXTURE);
  try {
    gitInit(dir, { commit: true });
    const link = linkBin(dir, AGENTMAP, "agentmap");
    const stdout = execFileSync(process.execPath, [link, "--hubs"], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    });
    assert.notEqual(stdout.trim(), "", "--hubs via bin symlink printed nothing");
    assert.match(stdout, /hubs/i);
  } finally { cleanup(dir); }
});

test("bin symlink: --install-hooks actually writes the hook", () => {
  const dir = makeRepo(FIXTURE);
  try {
    gitInit(dir, { commit: true });
    const link = linkBin(dir, AGENTMAP, "agentmap");
    const r = spawnSync(process.execPath, [link, "--install-hooks"], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(r.status, 0, `--install-hooks exited ${r.status}: ${r.stderr}`);
    assert.notEqual((r.stdout ?? "").trim(), "", "--install-hooks via bin symlink printed nothing");
    // The real regression: it used to print "Done" (or nothing) and install no hook.
    const hook = join(dir, ".git", "hooks", "post-commit");
    assert.ok(
      readFileSync(hook, "utf8").length > 0,
      "--install-hooks reported success via the bin symlink but wrote no post-commit hook",
    );
  } finally { cleanup(dir); }
});

test("bin symlink: --mcp serves the MCP Registry launch contract", () => {
  // server.json tells registry clients to run the npm package with `--mcp`,
  // i.e. through the bin symlink. That path returned zero bytes.
  const dir = makeRepo(FIXTURE);
  try {
    gitInit(dir, { commit: true });
    const link = linkBin(dir, AGENTMAP, "agentmap");
    const init = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    const r = spawnSync(process.execPath, [link, "--mcp"], {
      cwd: dir, encoding: "utf8", input: `${init}\n`, timeout: 30_000,
    });
    assert.notEqual((r.stdout ?? "").trim(), "", "--mcp via bin symlink produced no JSON-RPC response");
    const res = JSON.parse(r.stdout.split("\n").find((l) => l.trim().startsWith("{")));
    assert.equal(res.result?.serverInfo?.name, "agentmap");
  } finally { cleanup(dir); }
});

test("mcp.mjs run through its own symlink still serves", () => {
  const dir = makeRepo(FIXTURE);
  try {
    gitInit(dir, { commit: true });
    const link = linkBin(dir, MCP, "agentmap-mcp");
    const init = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    const r = spawnSync(process.execPath, [link, "--mcp"], {
      cwd: dir, encoding: "utf8", input: `${init}\n`, timeout: 30_000,
    });
    assert.notEqual((r.stdout ?? "").trim(), "", "mcp.mjs via symlink produced no JSON-RPC response");
  } finally { cleanup(dir); }
});

test("importing agentmap.mjs still executes nothing", async () => {
  // The guard must stay a guard: the realpath fix must not make an IMPORT look
  // like a direct run. argv[1] here is the test runner, not agentmap.mjs.
  const mod = await import(AGENTMAP);
  assert.equal(typeof mod.isDirectRun, "function");
  assert.equal(mod.isDirectRun(new URL(`file://${AGENTMAP}`).href), false,
    "isDirectRun returned true while imported by the test runner — the CLI would run on import");
});
