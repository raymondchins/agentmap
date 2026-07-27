// SPDX-License-Identifier: MIT
// Contract — ranking QUALITY, not just ranking stability.
//
// determinism.test.mjs proves two builds agree with each other and that a known
// file appears SOMEWHERE in hubs. Neither catches a ranking that is stably,
// reproducibly wrong: invert the comparator and every one of those assertions
// still passes. These tests assert ORDER against a fixture whose in-degrees are
// constructed and therefore known in advance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const MAP = ".claude/agentmap/map.json";

// A deliberate star: one file everything imports, one middling file, one leaf
// nobody imports. In-degrees are 5 / 2 / 0, unambiguous by construction.
const FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
  "src/core.ts": `export const core = 1;`,
  "src/mid.ts": `export const mid = 2;`,
  "src/leaf.ts": `export const leaf = 3;`,
  "src/a.ts": `import { core } from "./core";\nimport { mid } from "./mid";\nexport const a = core + mid;`,
  "src/b.ts": `import { core } from "./core";\nimport { mid } from "./mid";\nexport const b = core + mid;`,
  "src/c.ts": `import { core } from "./core";\nexport const c = core;`,
  "src/d.ts": `import { core } from "./core";\nexport const d = core;`,
  "src/e.ts": `import { core } from "./core";\nexport const e = core;`,
};

// hubs entries are display strings: "path (deg N, pr X)". Rank = array position.
const rankOf = (hubs, path) => hubs.findIndex((h) => h.startsWith(`${path} `) || h === path);
const degOf = (hubs, path) => {
  const e = hubs.find((h) => h.startsWith(`${path} `));
  const m = e && e.match(/deg (\d+)/);
  return m ? Number(m[1]) : null;
};

function buildHubs() {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const r = run(dir);
  assert.equal(r.status, 0, `build failed: ${r.stderr}`);
  const hubs = JSON.parse(readFileSync(join(dir, MAP), "utf8")).hubs;
  return { dir, hubs };
}

test("the most-imported file ranks FIRST, not merely somewhere in hubs", () => {
  const { dir, hubs } = buildHubs();
  assert.ok(hubs.length > 0, "no hubs produced");
  assert.ok(
    hubs[0].startsWith("src/core.ts "),
    `hubs[0] should be the 5-importer file, got: ${hubs[0]}\nfull: ${JSON.stringify(hubs)}`,
  );
  cleanup(dir);
});

test("in-degree is reported accurately for the constructed graph", () => {
  // Guards the number the ordering is derived from, so a correct order built on a
  // wrong degree still fails loudly.
  const { dir, hubs } = buildHubs();
  assert.equal(degOf(hubs, "src/core.ts"), 5, `core.ts should have 5 dependents: ${JSON.stringify(hubs)}`);
  assert.equal(degOf(hubs, "src/mid.ts"), 2, `mid.ts should have 2 dependents: ${JSON.stringify(hubs)}`);
  cleanup(dir);
});

test("a leaf nobody imports never outranks a file with importers", () => {
  const { dir, hubs } = buildHubs();
  const leaf = rankOf(hubs, "src/leaf.ts");
  const mid = rankOf(hubs, "src/mid.ts");
  assert.notEqual(mid, -1, `mid.ts (2 importers) missing from hubs: ${JSON.stringify(hubs)}`);
  // Absent is fine — a leaf has no claim on the list at all. Present-and-higher is not.
  if (leaf !== -1) {
    assert.ok(leaf > mid, `leaf.ts (0 importers) outranked mid.ts (2 importers): ${JSON.stringify(hubs)}`);
  }
  cleanup(dir);
});

test("hub order is monotonic in in-degree for this fixture", () => {
  // The whole point: an inverted or scrambled comparator survives every
  // determinism assertion and dies here.
  const { dir, hubs } = buildHubs();
  const degs = hubs.map((h) => { const m = h.match(/deg (\d+)/); return m ? Number(m[1]) : null; })
    .filter((d) => d !== null);
  for (let i = 1; i < degs.length; i++) {
    assert.ok(degs[i] <= degs[i - 1], `hubs are not ordered by descending degree at ${i}: ${JSON.stringify(hubs)}`);
  }
  cleanup(dir);
});

test("--symbols ranks the most-referenced export above a single-use one", () => {
  // Same idea one level down: symbol ranking, not file ranking.
  const { dir } = buildHubs();
  const r = run(dir, "--symbols", "20", "--json");
  assert.equal(r.status, 0, `--symbols failed: ${r.stderr}`);
  const names = JSON.parse(r.stdout).symbols.map((s) => s.name);
  const core = names.indexOf("core"), mid = names.indexOf("mid");
  assert.notEqual(core, -1, `"core" missing from ranked symbols: ${JSON.stringify(names)}`);
  if (mid !== -1) {
    assert.ok(core < mid, `"core" (5 referencing files) ranked below "mid" (2): ${JSON.stringify(names)}`);
  }
  cleanup(dir);
});
