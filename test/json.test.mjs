// SPDX-License-Identifier: MIT
// Contract #5 — `--json` global modifier. With --json present, the command
// prints EXACTLY ONE JSON object to stdout (no prose). We assert the documented
// shape per sub-command. Parsing stdout as a single JSON object is itself a
// strong assertion that no prose leaked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const FIXTURE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true }, include: ["**/*.ts", "app/**/*.ts"] }),
  "src/util.ts": `export function helper() { return 1; }`,
  "src/main.ts": `import { helper } from "./util";\nexport function main() { return helper(); }`,
  // an app/ route so --features / --feature have something to report
  "app/dashboard/page.ts": `export default function Page() { return null; }`,
};

// Parse the single JSON object the CLI must emit; fail loudly with the raw
// stdout if it isn't pure JSON (prose leak = contract violation).
function parseOne(r) {
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  let obj;
  try { obj = JSON.parse(r.stdout); }
  catch { assert.fail(`stdout was not a single JSON object:\n${r.stdout}`); }
  return obj;
}

test("--json --hubs emits {command:'hubs', fileCount, sha, hubs:[]}", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json", "--hubs"));
  assert.equal(o.command, "hubs");
  assert.equal(typeof o.fileCount, "number");
  assert.ok("sha" in o, "missing sha");
  assert.ok(Array.isArray(o.hubs), "hubs must be an array");
  cleanup(dir);
});

test("--json --find <sym> returns a matches array of {file,name,kind}", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json", "--find", "helper"));
  assert.equal(o.command, "find");
  assert.equal(o.query, "helper");
  assert.ok(Array.isArray(o.matches), "matches must be an array");
  assert.ok(o.matches.length >= 1, "expected at least one match for helper");
  const m = o.matches[0];
  for (const k of ["file", "name", "kind"]) assert.ok(k in m, `match missing ${k}`);
  cleanup(dir);
});

test("--json --features emits {command:'features', features:{name:count}}", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json", "--features"));
  assert.equal(o.command, "features");
  assert.equal(typeof o.features, "object");
  assert.equal(o.features.dashboard, 1, "expected dashboard feature with 1 file");
  cleanup(dir);
});

test("--json (bare) emits a build summary object", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json"));
  assert.equal(o.command, "build");
  assert.equal(typeof o.fileCount, "number");
  assert.equal(typeof o.features, "object");
  assert.ok("topHub" in o, "missing topHub");
  cleanup(dir);
});

test("--json --print includes top-level fileCount", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json", "--print"));
  assert.equal(typeof o.fileCount, "number", "--print JSON must include fileCount");
  assert.ok("files" in o, "--print JSON must include files map");
  cleanup(dir);
});

test("--json --relates emits the relates shape for a resolvable file", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json", "--relates", "util.ts"));
  assert.equal(o.command, "relates");
  assert.match(o.file, /util\.ts$/);
  assert.ok(Array.isArray(o.exports), "exports must be an array");
  assert.ok(Array.isArray(o.dependents), "dependents must be an array");
  assert.ok(Array.isArray(o.related), "related must be an array");
  // main.ts imports util.ts → util is a dependency-target with main as dependent.
  assert.ok(o.dependents.some((d) => /main\.ts$/.test(d)), "expected main.ts among dependents");
  cleanup(dir);
});

test("--json --map emits {command:'map', focus, budget, files:[]}", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json", "--map"));
  assert.equal(o.command, "map");
  assert.ok("focus" in o, "missing focus");
  assert.equal(typeof o.budget, "number", "budget must be a number");
  assert.ok(Array.isArray(o.files), "files must be an array");
  cleanup(dir);
});

test("--json --symbols n emits {command:'symbols', symbols:[{rank,file,name,kind}]}", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json", "--symbols", "5"));
  assert.equal(o.command, "symbols");
  assert.ok(Array.isArray(o.symbols), "symbols must be an array");
  cleanup(dir);
});

test("--json --feature emits the feature shape with files + externalDependents", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json", "--feature", "dashboard"));
  assert.equal(o.command, "feature");
  assert.equal(o.name, "dashboard");
  assert.ok(Array.isArray(o.files), "files must be an array");
  assert.ok(Array.isArray(o.externalDependents), "externalDependents must be an array");
  cleanup(dir);
});

test("--json --any <sym> emits {command:'any', query, kind, ...}", () => {
  const dir = makeRepo(FIXTURE);
  gitInit(dir, { commit: true });
  const o = parseOne(run(dir, "--json", "--any", "helper"));
  assert.equal(o.command, "any");
  assert.equal(o.query, "helper");
  assert.ok("kind" in o, "missing kind discriminator");
  cleanup(dir);
});
