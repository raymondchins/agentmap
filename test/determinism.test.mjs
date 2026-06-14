// SPDX-License-Identifier: MIT
// Contract #1 — determinism: two builds of the same tree produce a
// byte-identical hubs array. A repo map an agent re-runs on every commit MUST
// be stable, or diffs/caches churn meaninglessly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const MAP = ".claude/agentmap/map.json";

// A small but non-trivial import graph so hubs/pagerank are meaningful and
// ordering ties actually get exercised.
const FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
  "src/util.ts": `export function helper() { return 1; }\nexport const TOKEN = 42;`,
  "src/db.ts": `export function query() { return []; }`,
  "src/a.ts": `import { helper } from "./util";\nimport { query } from "./db";\nexport function a() { return helper() + query().length; }`,
  "src/b.ts": `import { helper } from "./util";\nexport function b() { return helper(); }`,
  "src/c.ts": `import { a } from "./a";\nimport { b } from "./b";\nexport function c() { return a() + b(); }`,
};

test("build is deterministic: hubs array byte-identical across two runs", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });

  const r1 = run(dir);
  assert.equal(r1.status, 0, `first build failed: ${r1.stderr}`);
  const map1 = readFileSync(join(dir, MAP), "utf8");
  const hubs1 = JSON.parse(map1).hubs;

  const r2 = run(dir);
  assert.equal(r2.status, 0, `second build failed: ${r2.stderr}`);
  const hubs2 = JSON.parse(readFileSync(join(dir, MAP), "utf8")).hubs;

  // Byte-identical serialization of the hubs array (order + content + spacing).
  assert.equal(JSON.stringify(hubs1), JSON.stringify(hubs2), "hubs differ between builds");
  // util.ts is imported by both a.ts and b.ts → it must surface as a hub.
  assert.ok(hubs1.some((h) => h.includes("src/util.ts")), "expected util.ts among hubs");
  cleanup(dir);
});

test("--hubs output is stable across repeated invocations", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const a = run(dir, "--hubs");
  const b = run(dir, "--hubs");
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(a.stdout, b.stdout, "--hubs stdout drifted between runs");
  cleanup(dir);
});
