// SPDX-License-Identifier: MIT
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, AGENTMAP, cleanup } from "./helpers.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function runWithHome(dir, homeDir, ...args) {
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
  try {
    const stdout = execFileSync(process.execPath, [AGENTMAP, ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? "",
      status: typeof e.status === "number" ? e.status : 1,
    };
  }
}

test("--setup-mcp creates configurations when none exist", () => {
  const dir = makeRepo({ "dummy.ts": "" });
  const homeDir = makeRepo({});
  gitInit(dir, { commit: true });

  const r = runWithHome(dir, homeDir, "--setup-mcp");
  assert.equal(r.status, 0, `--setup-mcp failed: ${r.stderr}`);

  // Check OpenCode global config
  const openCodeConfigPath = join(homeDir, ".config", "opencode", "opencode.json");
  assert.ok(existsSync(openCodeConfigPath), "OpenCode config should be created");
  const openCodeContent = JSON.parse(readFileSync(openCodeConfigPath, "utf8"));
  assert.ok(openCodeContent.mcp, "mcp object should exist");
  assert.ok(openCodeContent.mcp.agentmap, "agentmap mcp config should exist");
  assert.equal(openCodeContent.mcp.agentmap.type, "stdio");
  assert.equal(openCodeContent.mcp.agentmap.command, process.execPath);
  assert.ok(openCodeContent.mcp.agentmap.args[0].endsWith("mcp.mjs"), "arg should point to mcp.mjs");

  // Check Antigravity IDE config
  const geminiConfigPath = join(homeDir, ".gemini", "config", "mcp_config.json");
  assert.ok(existsSync(geminiConfigPath), "Antigravity IDE config should be created");
  const geminiContent = JSON.parse(readFileSync(geminiConfigPath, "utf8"));
  assert.ok(geminiContent.mcpServers, "mcpServers object should exist");
  assert.ok(geminiContent.mcpServers.agentmap, "agentmap server config should exist");
  assert.equal(geminiContent.mcpServers.agentmap.command, process.execPath);
  assert.ok(geminiContent.mcpServers.agentmap.args[0].endsWith("mcp.mjs"), "arg should point to mcp.mjs");

  cleanup(dir);
  cleanup(homeDir);
});

test("--setup-mcp merges configurations correctly with existing configs", () => {
  const dir = makeRepo({ "dummy.ts": "" });
  const homeDir = makeRepo({});
  gitInit(dir, { commit: true });

  // Setup pre-existing global OpenCode config
  const openCodeDir = join(homeDir, ".config", "opencode");
  mkdirSync(openCodeDir, { recursive: true });
  const openCodeConfigPath = join(openCodeDir, "opencode.json");
  writeFileSync(openCodeConfigPath, JSON.stringify({
    otherSetting: "keep-me",
    mcp: {
      otherServer: { type: "stdio", command: "cat" }
    }
  }));

  // Setup pre-existing Antigravity IDE config
  const geminiConfigDir = join(homeDir, ".gemini", "config");
  mkdirSync(geminiConfigDir, { recursive: true });
  const geminiConfigPath = join(geminiConfigDir, "mcp_config.json");
  writeFileSync(geminiConfigPath, JSON.stringify({
    mcpServers: {
      otherServer: { command: "echo" }
    }
  }));

  const r = runWithHome(dir, homeDir, "--setup-mcp");
  assert.equal(r.status, 0, `--setup-mcp failed: ${r.stderr}`);

  // Verify OpenCode merge
  const openCodeContent = JSON.parse(readFileSync(openCodeConfigPath, "utf8"));
  assert.equal(openCodeContent.otherSetting, "keep-me", "Unrelated settings should be preserved");
  assert.ok(openCodeContent.mcp.otherServer, "Pre-existing servers should be preserved");
  assert.ok(openCodeContent.mcp.agentmap, "agentmap server should be added");
  assert.equal(openCodeContent.mcp.agentmap.type, "stdio");

  // Verify Antigravity IDE merge
  const geminiContent = JSON.parse(readFileSync(geminiConfigPath, "utf8"));
  assert.ok(geminiContent.mcpServers.otherServer, "Pre-existing servers should be preserved");
  assert.ok(geminiContent.mcpServers.agentmap, "agentmap server should be added");
  assert.equal(geminiContent.mcpServers.agentmap.command, process.execPath);

  cleanup(dir);
  cleanup(homeDir);
});

test("--setup-mcp --dry-run prints plan without writing files", () => {
  const dir = makeRepo({ "dummy.ts": "" });
  const homeDir = makeRepo({});
  gitInit(dir, { commit: true });

  const r = runWithHome(dir, homeDir, "--setup-mcp", "--dry-run");
  assert.equal(r.status, 0, `--setup-mcp --dry-run failed: ${r.stderr}`);
  
  assert.ok(r.stdout.includes("would configure MCP server"), "Should log dry-run heading");
  assert.ok(r.stdout.includes("OpenCode: would write to"), "Should log OpenCode plan");
  assert.ok(r.stdout.includes("Antigravity IDE: would write to"), "Should log Antigravity IDE plan");

  // Verify no files are written
  const openCodeConfigPath = join(homeDir, ".config", "opencode", "opencode.json");
  const geminiConfigPath = join(homeDir, ".gemini", "config", "mcp_config.json");
  assert.ok(!existsSync(openCodeConfigPath), "OpenCode config should not be created under dry-run");
  assert.ok(!existsSync(geminiConfigPath), "Antigravity IDE config should not be created under dry-run");

  cleanup(dir);
  cleanup(homeDir);
});

test("--setup-mcp throws and creates backup on malformed JSON config", () => {
  const dir = makeRepo({ "dummy.ts": "" });
  const homeDir = makeRepo({});
  gitInit(dir, { commit: true });

  // Setup malformed global OpenCode config
  const openCodeDir = join(homeDir, ".config", "opencode");
  mkdirSync(openCodeDir, { recursive: true });
  const openCodeConfigPath = join(openCodeDir, "opencode.json");
  writeFileSync(openCodeConfigPath, "{ malformed json }");

  const r = runWithHome(dir, homeDir, "--setup-mcp");
  assert.equal(r.status, 1, "Should fail with code 1");
  assert.ok(r.stderr.includes("agentmap --setup-mcp failed"), "Should print failure message on stderr");
  
  // Verify backup is created and live file is not clobbered with `{}`
  assert.ok(existsSync(openCodeConfigPath + ".bak"), "Backup should be created");
  assert.equal(readFileSync(openCodeConfigPath, "utf8"), "{ malformed json }", "Original file should not be clobbered");

  cleanup(dir);
  cleanup(homeDir);
});
