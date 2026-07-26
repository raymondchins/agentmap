// SPDX-License-Identifier: MIT
// ============================================================================
//  Concurrent-build safety for assemble()'s atomic write (agentmap.mjs:1654-1670).
//
//  Two agent sessions querying ONE repo at the same time both reach build() —
//  nothing on the CLI/MCP query path takes a lock (only hooks/post-commit does,
//  and only for its own invocations). Before the fix, every writer used the SAME
//  literal tmp path (`.claude/agentmap/map.json.tmp`), so the winner renamed it
//  away and every loser's renameSync threw an uncaught
//    ENOENT: no such file or directory, rename '.claude/agentmap/map.json.tmp'
//  straight out of assemble() -> build() -> ensureFresh() -> main(). There is no
//  top-level catch, so an ordinary query hard-crashed. Measured pre-fix: 2 of 18
//  processes across 3 rounds of 6 concurrent queries on a 150-file repo.
//
//  Note what is NOT claimed here: torn/interleaved JSON was the hypothesised
//  failure and did not reproduce (0 tears in 8 synthetic rounds at 6MB and 96MB
//  payloads, plus every round below). The crash is the real defect. The tests
//  still assert map.json parses, because that is the invariant that must hold
//  regardless of which failure mode a future regression takes.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeRepo, gitInit, run, cleanup, AGENTMAP } from "./helpers.mjs";

const MAP_DIR = join(".claude", "agentmap");

// A chain repo: each file imports the previous one, so there are real edges to
// resolve and the build does enough work for concurrent runs to overlap.
function chainRepo(n) {
  const files = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler" },
      include: ["src/**/*"],
    }),
  };
  for (let i = 0; i < n; i++) {
    const dep = i > 0 ? `import { v${i - 1} } from "./file${i - 1}";\n` : "";
    const use = i > 0 ? ` + v${i - 1}` : "";
    files[`src/file${i}.ts`] = `${dep}export const v${i} = ${i}${use};\nexport function fn${i}() { return v${i}; }\n`;
  }
  return files;
}

// ---------------------------------------------------------------------------
// 1. Deterministic guard. Occupying the OLD shared tmp path with a DIRECTORY
//    makes it unwritable: pre-fix, writeFileSync(tmp, …) throws EISDIR and the
//    build dies. Post-fix the path is per-process, so the squatter is simply
//    never touched. This asserts the structural property — "no writer uses the
//    shared name" — without having to win a timing race, so it cannot go flaky.
// ---------------------------------------------------------------------------
test("build never writes the shared, non-PID-suffixed tmp path", () => {
  const dir = makeRepo(chainRepo(6));
  gitInit(dir, { commit: true });
  try {
    // Squat every legacy shared tmp path with an unwritable directory.
    for (const squat of ["map.json.tmp", "map.dirty.json.tmp", "facts.json.tmp"]) {
      mkdirSync(join(dir, MAP_DIR, squat), { recursive: true });
    }
    const r = run(dir);
    assert.equal(r.status, 0, `build failed with the legacy tmp path occupied: ${r.stderr}`);

    const mapPath = join(dir, MAP_DIR, "map.json");
    assert.ok(existsSync(mapPath), "map.json was never written");
    const map = JSON.parse(readFileSync(mapPath, "utf8")); // throws if torn
    assert.equal(map.fileCount, 6, "the squatter must not affect what gets indexed");

    // The squatters must still be directories — proof nothing wrote through them.
    for (const squat of ["map.json.tmp", "facts.json.tmp"]) {
      assert.ok(existsSync(join(dir, MAP_DIR, squat)), `${squat} disappeared — something touched the shared path`);
    }
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// 2. The real scenario: N concurrent queries, cold cache, one repo.
//    Pre-fix this failed with ENOENT in a minority of processes per round;
//    post-fix it is clean. Kept as a smoke test — it is the only case that
//    exercises the actual race rather than a proxy for it.
// ---------------------------------------------------------------------------
test("concurrent cold-cache queries all succeed and leave a valid map.json", async () => {
  const N = 6;
  const dir = makeRepo(chainRepo(40));
  gitInit(dir, { commit: true });
  try {
    const results = await Promise.all(
      Array.from({ length: N }, () => new Promise((resolve) => {
        const kid = spawn(process.execPath, [AGENTMAP, "--json", "--hubs"], {
          cwd: dir, stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        kid.stdout.resume();
        kid.stderr.on("data", (d) => { stderr += d; });
        kid.on("exit", (code) => resolve({ code, stderr }));
      })),
    );

    const failed = results.filter((r) => r.code !== 0);
    assert.equal(
      failed.length, 0,
      `${failed.length}/${N} concurrent queries crashed; first stderr:\n${failed[0]?.stderr ?? ""}`,
    );
    // Name the specific regression, so a future failure reads as a diagnosis.
    const enoent = results.filter((r) => /ENOENT.*\.tmp/.test(r.stderr));
    assert.equal(enoent.length, 0, `a writer lost its tmp file to another process:\n${enoent[0]?.stderr ?? ""}`);

    const map = JSON.parse(readFileSync(join(dir, MAP_DIR, "map.json"), "utf8")); // throws if torn
    assert.equal(map.fileCount, 40);

    // Every writer renamed its own tmp away; none may be left behind.
    const strays = readdirSync(join(dir, MAP_DIR)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(strays, [], `stray tmp files left behind: ${strays.join(", ")}`);
  } finally { cleanup(dir); }
});
