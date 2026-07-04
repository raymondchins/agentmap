// SPDX-License-Identifier: MIT
// ============================================================================
//  Security regression — ReDoS in the .agentmapignore glob→regex matcher.
//
//  A line of many consecutive `*` used to translate to adjacent `[^/]*[^/]*…`
//  groups (catastrophic backtracking): a `*`×50 line hung the per-path matcher
//  ~80s, freezing build() + the post-commit hook + the MCP server. The fix
//  collapses `*` runs (this subset has no `**` semantics) + caps line length, so
//  a poisoned ignore file now builds in well under a second. These lock that in
//  and prove the matcher still functions (no over/under-matching regression).
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const AGENTMAP = fileURLToPath(new URL("../agentmap.mjs", import.meta.url));

test("poisoned .agentmapignore (ReDoS payload) does NOT hang the build", () => {
  const dir = makeRepo({
    // 50 consecutive `*` + a trailing literal — the catastrophic-backtracking
    // shape. Pre-fix this froze the matcher ~80s per path.
    ".agentmapignore": "*".repeat(50) + "needle\n",
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "import { a } from './a';\nexport const b = a + 1;\n",
  });
  try {
    gitInit(dir, { commit: true });
    const t0 = Date.now();
    // Hard 15s ceiling. If the ReDoS were present this build would take ~80s and
    // spawnSync would kill it (SIGTERM / ETIMEDOUT) — which we assert against.
    const r = spawnSync(process.execPath, [AGENTMAP, "--hubs"], { cwd: dir, encoding: "utf8", timeout: 15000 });
    const ms = Date.now() - t0;
    assert.notEqual(r.signal, "SIGTERM", `build was killed by the 15s timeout — ReDoS not fixed (${ms}ms)`);
    assert.equal(r.error?.code, undefined, `build errored/timed out: ${r.error?.code} (${ms}ms)`);
    assert.equal(r.status, 0, `build should exit 0, got ${r.status} (${ms}ms)`);
    assert.ok(ms < 10000, `build must finish fast; took ${ms}ms (ReDoS would be ~80s)`);
  } finally { cleanup(dir); }
});

test("a `*` glob in .agentmapignore still excludes matched files (no functional regression)", () => {
  const dir = makeRepo({
    ".agentmapignore": "gen-*\n",           // collapses/normalizes but must still match gen-<anything>
    "src/gen-types.ts": "export const generated = 1;\n",
    "src/real.ts": "export const real = 2;\n",
  });
  try {
    gitInit(dir, { commit: true });
    const j = JSON.parse(run(dir, "--map", "--json").stdout);
    const names = j.files.map((f) => f.file);
    assert.ok(names.includes("src/real.ts"), "a non-ignored file must remain in the map");
    assert.ok(!names.some((n) => n.includes("gen-types")), "the `gen-*` glob must still exclude gen-types.ts");
  } finally { cleanup(dir); }
});
