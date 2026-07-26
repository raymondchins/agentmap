// SPDX-License-Identifier: MIT
// ============================================================================
//  --affected (source -> covering tests) and --kind (filter by declaration kind).
//
//  --affected answers "what do I re-run after changing this", and — more useful
//  before a risky edit — "does anything cover this at all". An empty list is the
//  ANSWER, not a failure, so it must be stated plainly rather than looking like
//  a lookup that went wrong.
//
//  Run: node --test test/affected-kind.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// core <- mid <- feature.test  (2 hops), core <- direct.test (1 hop),
// and `orphan.ts` which nothing tests at all.
function repo() {
  return {
    "src/core.ts": "export function core(){ return 1; }\n",
    "src/mid.ts": 'import { core } from "./core";\nexport function mid(){ return core() + 1; }\n',
    "src/orphan.ts": "export function orphan(){ return 0; }\n",
    "test/direct.test.mjs": 'import { core } from "../src/core.ts";\ncore();\n',
    "test/feature.test.mjs": 'import { mid } from "../src/mid.ts";\nmid();\n',
    // Named to look testish without being a test: `latest` contains "test" as a
    // substring, and a bare-substring check would wrongly count it.
    "src/latest/helper.ts": "export function helper(){ return 2; }\n",
  };
}

const json = (dir, ...a) => JSON.parse(run(dir, ...a, "--json").stdout);

test("--affected reports covering tests with their hop distance", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const j = json(dir, "--affected", "src/core.ts");
    const byFile = Object.fromEntries(j.affected.map((a) => [a.file, a.hop]));
    assert.equal(byFile["test/direct.test.mjs"], 1, "direct importer is 1 hop");
    assert.equal(byFile["test/feature.test.mjs"], 2, "reached through mid.ts is 2 hops");
    assert.equal(j.tests, 2);
    assert.equal(j.covered, true);
  } finally { cleanup(dir); }
});

test("an uncovered file says so — the empty list is the answer", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--affected", "src/orphan.ts");
    assert.equal(r.status, 0, "no coverage is a valid answer, not an error");
    const j = JSON.parse(run(dir, "--affected", "src/orphan.ts", "--json").stdout);
    assert.deepEqual(j.affected, []);
    assert.equal(j.covered, false);
    assert.match(r.stdout, /no test coverage/i, "must say it in words, not just print nothing");
  } finally { cleanup(dir); }
});

test("a path segment merely CONTAINING 'test' is not a test file", () => {
  const dir = makeRepo({
    ...repo(),
    // src/latest/helper.ts is imported by a real test, so it will appear in the
    // dependents walk — but it must never be counted as a test file itself.
    "test/uses-latest.test.mjs": 'import { helper } from "../src/latest/helper.ts";\nhelper();\n',
  });
  try {
    gitInit(dir, { commit: true });
    const j = json(dir, "--affected", "src/latest/helper.ts");
    assert.ok(!j.affected.some((a) => a.file === "src/latest/helper.ts"), "the file itself is never its own test");
    assert.deepEqual(j.affected.map((a) => a.file), ["test/uses-latest.test.mjs"]);
  } finally { cleanup(dir); }
});

test("--affected accepts a bare filename but refuses to guess when ambiguous", () => {
  const dir = makeRepo({
    "src/a/thing.ts": "export const a = 1;\n",
    "src/b/thing.ts": "export const b = 2;\n",
    "src/only.ts": "export const c = 3;\n",
  });
  try {
    gitInit(dir, { commit: true });
    const uniq = run(dir, "--affected", "only.ts", "--json");
    assert.equal(JSON.parse(uniq.stdout).file, "src/only.ts", "an unambiguous suffix resolves");
    const amb = run(dir, "--affected", "thing.ts", "--json");
    assert.equal(amb.status, 1);
    const j = JSON.parse(amb.stdout);
    assert.equal(j.error, "ambiguous");
    assert.equal(j.candidates.length, 2, "picking one silently would answer a question nobody asked");
  } finally { cleanup(dir); }
});

test("--affected on an unknown path exits 1", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--affected", "src/nope.ts", "--json");
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error, "no match");
  } finally { cleanup(dir); }
});

test("--kind narrows --find loosely, without ts-morph enum spelling", () => {
  const dir = makeRepo({
    "src/mix.ts":
      "export function doThing(){ return 1; }\n" +
      "export type ThingShape = { a: number };\n" +
      "export const thingConst = 3;\n" +
      "export interface ThingIface { b: string }\n",
  });
  try {
    gitInit(dir, { commit: true });
    const all = json(dir, "--find", "thing");
    assert.equal(all.total, 4);
    // `function` must match FunctionDeclaration, `type` TypeAliasDeclaration, etc.
    assert.deepEqual(json(dir, "--find", "thing", "--kind", "function").matches.map((m) => m.name), ["doThing"]);
    assert.deepEqual(json(dir, "--find", "thing", "--kind", "type").matches.map((m) => m.name), ["ThingShape"]);
    assert.deepEqual(json(dir, "--find", "thing", "--kind", "interface").matches.map((m) => m.name), ["ThingIface"]);
    // Case-insensitive, and echoed back so an empty result is explicable.
    assert.equal(json(dir, "--find", "thing", "--kind", "FUNCTION").total, 1);
    assert.equal(json(dir, "--find", "thing", "--kind", "function").kind, "function");
  } finally { cleanup(dir); }
});

test("a --kind that matches nothing is an honest empty result, exit 1", () => {
  const dir = makeRepo({ "src/mix.ts": "export function doThing(){ return 1; }\n" });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--find", "thing", "--kind", "enum", "--json");
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).total, 0);
  } finally { cleanup(dir); }
});

test("--kind is a modifier, not a command — orphaned it is a usage error", () => {
  const dir = makeRepo({ "src/a.ts": "export const a = 1;\n" });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--kind", "function");
    assert.equal(r.status, 2, "--kind with no --find/--search must not silently build the map");
  } finally { cleanup(dir); }
});
