// SPDX-License-Identifier: MIT
// ============================================================================
//  Non-exported TOP-LEVEL symbol indexing (schema 4, v0.13).
//
//  agentmap used to index EXPORTED declarations only — extractFacts() built each
//  file's `exports` array purely from sf.getExportedDeclarations(), and every
//  symbol query (--find / --any) iterated that list. A private top-level
//  `function helper(){}` was therefore invisible, defeating reuse-before-rebuild.
//
//  Now each file also carries `locals` (non-exported module-scope decls), which
//  --find / --any surface. The load-bearing invariant: `locals` are DISCOVERY-ONLY
//  — rankSymbols / --map / --symbols / --hubs never read them, so the focused
//  ranked digest is byte-identical to before (see the FOCUSED-MAP INVARIANT test).
//
//  Run: node --test test/symbol-index.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, writeFiles, git, run, cleanup } from "./helpers.mjs";

const readMap = (dir) =>
  JSON.parse(readFileSync(join(dir, ".claude/agentmap/map.json"), "utf8"));

// One file with BOTH an exported symbol and a non-exported top-level helper.
// `internalHelper` is a bare top-level declaration with no `export` keyword — the
// case the old getExportedDeclarations()-only pipeline dropped.
function mixedRepo() {
  return {
    "src/mod.ts": [
      "function internalHelper() { return 41; }", // non-exported, top-level
      "export function exportedThing() {", // exported
      "  return internalHelper() + 1;",
      "}",
      "",
    ].join("\n"),
  };
}

test("--find surfaces a non-exported top-level helper (marked local)", () => {
  const dir = makeRepo(mixedRepo());
  try {
    gitInit(dir, { commit: true });
    const o = JSON.parse(run(dir, "--find", "internalHelper", "--json").stdout);
    assert.equal(o.command, "find");
    const hit = o.matches.find((m) => m.name === "internalHelper");
    assert.ok(hit, `non-exported helper must be findable (matches=${JSON.stringify(o.matches)})`);
    assert.equal(hit.file, "src/mod.ts");
    assert.equal(hit.local, true, "a non-exported hit must carry local:true so callers can distinguish it");
  } finally { cleanup(dir); }
});

test("--any routes a non-exported helper query to a STRUCTURE (graph) hit, not git-grep", () => {
  const dir = makeRepo(mixedRepo());
  try {
    gitInit(dir, { commit: true });
    const o = JSON.parse(run(dir, "--any", "internalHelper", "--json").stdout);
    assert.equal(o.kind, "structure", `expected an indexed symbol hit, got kind=${o.kind}`);
    assert.ok(
      o.symbols.some((s) => s.name === "internalHelper" && s.file === "src/mod.ts"),
      `--any must surface the non-exported helper as a structured symbol (symbols=${JSON.stringify(o.symbols)})`,
    );
  } finally { cleanup(dir); }
});

test("exported symbols stay findable and are NOT marked local (no regression)", () => {
  const dir = makeRepo(mixedRepo());
  try {
    gitInit(dir, { commit: true });
    const o = JSON.parse(run(dir, "--find", "exportedThing", "--json").stdout);
    const hit = o.matches.find((m) => m.name === "exportedThing");
    assert.ok(hit, "the exported symbol must remain findable");
    assert.ok(!("local" in hit), "an exported hit must NOT carry a local marker");
  } finally { cleanup(dir); }
});

test("FOCUSED-MAP INVARIANT: a local is indexed but never ranked", () => {
  const dir = makeRepo(mixedRepo());
  try {
    gitInit(dir, { commit: true });
    run(dir, "--symbols", "--json"); // force a build
    const map = readMap(dir);
    const f = map.files["src/mod.ts"];
    // Indexed into `locals` …
    assert.ok(f.locals.some((l) => l.name === "internalHelper"), "helper must be in files.locals");
    // … but NEVER in `exports` …
    assert.ok(!f.exports.some((e) => e.name === "internalHelper"), "a local must not leak into exports");
    // … and NEVER in the ranked digest (this is what keeps --map/--symbols byte-identical).
    assert.ok(!map.rankedSymbols.some((s) => s.name === "internalHelper"), "a local must NOT enter rankedSymbols");
    // The real exported symbol still ranks.
    assert.ok(map.rankedSymbols.some((s) => s.name === "exportedThing"), "the exported symbol must still rank");
    // --symbols output must not show the local either.
    const syms = JSON.parse(run(dir, "--symbols", "--json").stdout);
    const list = Array.isArray(syms) ? syms : syms.symbols || syms.rankedSymbols || [];
    assert.ok(!JSON.stringify(list).includes("internalHelper"), "--symbols must not surface a local");
  } finally { cleanup(dir); }
});

test("TOP-LEVEL-ONLY: declarations nested in a function body are NOT indexed", () => {
  const dir = makeRepo({
    "src/body.ts": [
      "export function outer() {",
      "  function bodyLocal() { return 1; }", // nested → must be invisible
      "  const bodyConst = 2;", // nested → must be invisible
      "  return bodyLocal() + bodyConst;",
      "}",
      "",
    ].join("\n"),
  });
  try {
    gitInit(dir, { commit: true });
    const a = JSON.parse(run(dir, "--find", "bodyLocal", "--json").stdout);
    assert.equal(a.total, 0, `body-local function must not be indexed (matches=${JSON.stringify(a.matches)})`);
    const b = JSON.parse(run(dir, "--find", "bodyConst", "--json").stdout);
    assert.equal(b.total, 0, "body-local const must not be indexed");
  } finally { cleanup(dir); }
});

test("--no-locals suppresses locals from --find (escape hatch), default shows them", () => {
  const dir = makeRepo(mixedRepo());
  try {
    gitInit(dir, { commit: true });
    const shown = JSON.parse(run(dir, "--find", "internalHelper", "--json").stdout);
    assert.ok(shown.matches.some((m) => m.name === "internalHelper"), "default must show the local");
    const hidden = JSON.parse(run(dir, "--find", "internalHelper", "--no-locals", "--json").stdout);
    assert.equal(hidden.total, 0, "--no-locals must hide the local");
    // Exports must still be findable WITH --no-locals.
    const exp = JSON.parse(run(dir, "--find", "exportedThing", "--no-locals", "--json").stdout);
    assert.ok(exp.matches.some((m) => m.name === "exportedThing"), "--no-locals must not hide exports");
  } finally { cleanup(dir); }
});

test("all top-level declaration kinds index (fn / class / interface / type / enum / const)", () => {
  const dir = makeRepo({
    "src/kinds.ts": [
      "function fnLocal() {}",
      "class ClassLocal {}",
      "interface IfaceLocal { x: number }",
      "type TypeLocal = string;",
      "enum EnumLocal { A, B }",
      "const constLocal = () => {};",
      "export const anchor = 1;", // keeps the file a graph node
      "",
    ].join("\n"),
  });
  try {
    gitInit(dir, { commit: true });
    for (const name of ["fnLocal", "ClassLocal", "IfaceLocal", "TypeLocal", "EnumLocal", "constLocal"]) {
      const o = JSON.parse(run(dir, "--find", name, "--json").stdout);
      assert.ok(o.matches.some((m) => m.name === name), `${name} (non-exported top-level) must be findable`);
    }
  } finally { cleanup(dir); }
});

test("collision: an exported name in one file and a private name in another both surface, deduped", () => {
  const dir = makeRepo({
    "src/a.ts": "export function shared() { return 'a'; }\n",
    "src/b.ts": "function shared() { return 'b'; }\nexport function useB() { return shared(); }\n",
  });
  try {
    gitInit(dir, { commit: true });
    const o = JSON.parse(run(dir, "--find", "shared", "--json").stdout);
    const byFile = new Map(o.matches.filter((m) => m.name === "shared").map((m) => [m.file, m]));
    assert.ok(byFile.has("src/a.ts"), "exported `shared` in a.ts must surface");
    assert.ok(byFile.has("src/b.ts"), "private `shared` in b.ts must surface");
    assert.equal(byFile.size, o.matches.filter((m) => m.name === "shared").length, "no duplicate (file,name) pairs");
    assert.ok(!("local" in byFile.get("src/a.ts")), "the exported one is not marked local");
    assert.equal(byFile.get("src/b.ts").local, true, "the private one is marked local");
  } finally { cleanup(dir); }
});

test("incremental: a private helper added in a later commit becomes findable", () => {
  const dir = makeRepo({ "src/mod.ts": "export function seed() { return 1; }\n" });
  try {
    gitInit(dir, { commit: true });
    run(dir, "--find", "seed", "--json"); // baseline build
    writeFiles(dir, { "src/mod.ts": "function lateHelper() { return 2; }\nexport function seed() { return lateHelper(); }\n" });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add helper", "--no-verify");
    const o = JSON.parse(run(dir, "--find", "lateHelper", "--json").stdout);
    assert.ok(o.matches.some((m) => m.name === "lateHelper"), "incremental rebuild must pick up the new private helper");
  } finally { cleanup(dir); }
});

test("JS: a non-exported top-level const in a .js file indexes", () => {
  const dir = makeRepo({ "src/util.js": "const jsHelper = () => 1;\nconsole.log(jsHelper());\n" });
  try {
    gitInit(dir, { commit: true });
    const o = JSON.parse(run(dir, "--find", "jsHelper", "--json").stdout);
    assert.ok(o.matches.some((m) => m.name === "jsHelper" && m.file === "src/util.js"), "JS top-level const must index as a local");
  } finally { cleanup(dir); }
});

test("indexing a local does not fabricate a dependency edge", () => {
  // Making internalHelper searchable must not turn it into an import/dependent
  // edge — the file has no cross-file importer, so dependents stay empty.
  const dir = makeRepo(mixedRepo());
  try {
    gitInit(dir, { commit: true });
    const o = JSON.parse(run(dir, "--relates", "src/mod.ts", "--json").stdout);
    assert.deepEqual(o.dependents, [], "no importer exists → dependents must stay empty");
  } finally { cleanup(dir); }
});
