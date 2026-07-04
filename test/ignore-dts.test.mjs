// SPDX-License-Identifier: MIT
// ============================================================================
//  .agentmapignore + .d.ts default-exclude (FIX #6).
//   (1) a repo-root .agentmapignore (gitignore-style subset) drops matched
//       dirs/files from the map (their symbols vanish from --find);
//   (2) a .d.ts file's symbols are excluded from --find/--symbols/--hubs by
//       DEFAULT, and --include-dts restores them;
//   (3) an import that RESOLVES to a .d.ts still forms an edge (the importer
//       keeps it in its imports list) even though the .d.ts isn't a ranked node;
//   (4) no regression: a repo with NO .d.ts and NO .agentmapignore is unchanged.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// A fixture that TRIGGERS the change: a generated .d.ts with symbols, a runtime
// importer that resolves to it (the edge that must survive), plus a plain .ts so
// the map is never empty.
function dtsRepo() {
  return makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
    // generated declaration file — its symbols should NOT reach --find by default
    "src/database.d.ts": "export declare function generatedFn(): void;\nexport type DBHelper = { q: string };\n",
    // a real runtime import that ts-morph resolves to database.d.ts → the edge
    "src/uses-dts.ts": "import { generatedFn } from './database';\nexport function callIt() { return generatedFn(); }\n",
    // an ordinary source file (control)
    "src/index.ts": "export function realThing() { return 1; }\n",
  });
}

test(".d.ts symbols are excluded from --find by DEFAULT", () => {
  const dir = dtsRepo();
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--find", "generatedFn", "--json");
    // exit 1 = zero results (documented contract) — the .d.ts symbol is gone
    assert.equal(r.status, 1, `expected exit 1 (no results), got ${r.status}: ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.total, 0, "the .d.ts symbol must NOT appear in --find by default");
    assert.deepEqual(j.matches, []);
  } finally { cleanup(dir); }
});

test("--include-dts restores the .d.ts symbols to --find", () => {
  const dir = dtsRepo();
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--find", "generatedFn", "--include-dts", "--json");
    assert.equal(r.status, 0, `--include-dts should find the symbol: ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.total, 1, "--include-dts must surface the .d.ts symbol");
    assert.equal(j.matches[0].file, "src/database.d.ts");
    assert.equal(j.matches[0].name, "generatedFn");
  } finally { cleanup(dir); }
});

test(".d.ts symbols are excluded from --symbols and --hubs by default", () => {
  const dir = dtsRepo();
  try {
    gitInit(dir, { commit: true });
    const syms = run(dir, "--symbols", "20");
    assert.equal(syms.status, 0, syms.stderr);
    assert.doesNotMatch(syms.stdout, /database\.d\.ts/, ".d.ts must not appear in --symbols");
    const hubs = run(dir, "--hubs");
    assert.equal(hubs.status, 0, hubs.stderr);
    assert.doesNotMatch(hubs.stdout, /database\.d\.ts/, ".d.ts must not appear in --hubs");
  } finally { cleanup(dir); }
});

test("an import RESOLVING to a .d.ts still yields an edge (importer keeps it)", () => {
  const dir = dtsRepo();
  try {
    gitInit(dir, { commit: true });
    // The importer's own imports list must still contain the .d.ts target — the
    // edge is preserved even though the .d.ts is not itself a ranked map node.
    const r = run(dir, "--relates", "src/uses-dts.ts", "--json");
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.ok(j.imports.includes("src/database.d.ts"),
      `the edge to the .d.ts must survive; got imports=${JSON.stringify(j.imports)}`);
  } finally { cleanup(dir); }
});

test(".agentmapignore excludes a matched directory and file (symbols vanish)", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
    "src/index.ts": "export function keepMe() { return 1; }\n",
    "generated/big.ts": "export function generatedGarbage() { return 2; }\n",
    "vendor/lib.ts": "export function vendorFn() { return 3; }\n",
    ".agentmapignore": "# drop generated code + vendored libs\ngenerated/\nvendor/lib.ts\n",
  });
  try {
    gitInit(dir, { commit: true });
    // matched dir (generated/) is gone
    const g = run(dir, "--find", "generatedGarbage", "--json");
    assert.equal(g.status, 1, "ignored-dir symbol must be absent");
    assert.equal(JSON.parse(g.stdout).total, 0);
    // matched literal file (vendor/lib.ts) is gone
    const v = run(dir, "--find", "vendorFn", "--json");
    assert.equal(v.status, 1, "ignored-file symbol must be absent");
    assert.equal(JSON.parse(v.stdout).total, 0);
    // the un-ignored file still resolves
    const k = run(dir, "--find", "keepMe", "--json");
    assert.equal(k.status, 0, k.stderr);
    assert.equal(JSON.parse(k.stdout).total, 1, "the un-ignored symbol must still be found");
  } finally { cleanup(dir); }
});

test("NO regression: repo with no .d.ts and no .agentmapignore resolves normally", () => {
  const dir = makeRepo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts"] }),
    "src/util.ts": "export function helper() { return 1; }\n",
    "src/index.ts": "import { helper } from './util';\nexport function main() { return helper(); }\n",
  });
  try {
    gitInit(dir, { commit: true });
    const f = run(dir, "--find", "helper", "--json");
    assert.equal(f.status, 0, f.stderr);
    assert.equal(JSON.parse(f.stdout).total, 1, "a normal symbol must still resolve");
    const rel = run(dir, "--relates", "src/index.ts", "--json");
    assert.ok(JSON.parse(rel.stdout).imports.includes("src/util.ts"), "normal edges must still form");
  } finally { cleanup(dir); }
});
