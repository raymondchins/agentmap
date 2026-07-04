// SPDX-License-Identifier: MIT
// ============================================================================
//  Map-health / degraded-signal tests. A repo whose imports don't resolve (e.g.
//  aliases living only in vite.config, which agentmap doesn't read) used to print
//  a flat map + "built N files" and exit 0 with zero signal — garbage framed as
//  success. These lock in the honest signal: an `edgeCoverage` field + a `degraded`
//  boolean on map.json AND the --json build output, plus one stderr warning line on
//  the clean build. Byte-safety twin: a HEALTHY repo must NOT warn, must report
//  degraded:false, and must keep every pre-existing map.json field unchanged.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, run, runErr, cleanup } from "./helpers.mjs";

const readMap = (dir) => JSON.parse(readFileSync(join(dir, ".claude/agentmap/map.json"), "utf8"));

// A repo whose only cross-file imports use a `@/` alias agentmap cannot resolve —
// defined nowhere agentmap reads (no tsconfig paths, no STRING vite/webpack alias:
// think a webpack *function* alias, a bundler plugin, or a bespoke resolver). `@/`
// still counts as a repo-local import site, so every miss drives edgeCoverage → ~0.
// 14 files, so fileCount>10 and coverage<0.15 both trip. (Deliberately NOT a plain
// vite string alias — agentmap now resolves those, which would make this healthy.)
function degradedRepo() {
  const files = {
    "src/utils/helper.js": "export function helper() { return 1; }\n",
    "src/utils/shared.js": "export function shared() { return 2; }\n",
  };
  for (let i = 1; i <= 12; i++) {
    files[`src/components/C${i}.js`] =
      `import { helper } from "@/utils/helper";\nimport { shared } from "@/utils/shared";\nexport function C${i}() { return helper() + shared(); }\n`;
  }
  return files;
}

// A healthy repo of the same size whose imports are RELATIVE and all resolve.
function healthyRepo() {
  const files = { "src/util.js": "export function util() { return 1; }\n" };
  for (let i = 1; i <= 12; i++) {
    files[`src/m${i}.js`] = `import { util } from "./util";\nexport function m${i}() { return util() + ${i}; }\n`;
  }
  return files;
}

test("degraded repo: warns + degraded:true + low edgeCoverage on stderr build", () => {
  const dir = makeRepo(degradedRepo());
  gitInit(dir, { commit: true });
  const r = runErr(dir); // bare build → one-line summary + build stderr
  assert.equal(r.status, 0);
  assert.match(r.stderr, /import edge/, "degraded warning line must be printed to stderr");
  assert.match(r.stderr, /most imports unresolved/, "warning must name the unresolved-imports problem");
  const m = readMap(dir);
  assert.equal(m.degraded, true, "map.json degraded must be true");
  assert.equal(typeof m.edgeCoverage, "number");
  assert.ok(m.edgeCoverage < 0.15, `edgeCoverage ${m.edgeCoverage} must be < 0.15`);
  assert.ok(m.fileCount > 10);
  cleanup(dir);
});

test("degraded repo: --json build surfaces degraded + edgeCoverage", () => {
  const dir = makeRepo(degradedRepo());
  gitInit(dir, { commit: true });
  const r = run(dir, "--json");
  assert.equal(r.status, 0);
  const obj = JSON.parse(r.stdout);
  assert.equal(obj.command, "build");
  assert.equal(obj.degraded, true);
  assert.equal(typeof obj.edgeCoverage, "number");
  assert.ok(obj.edgeCoverage < 0.15);
  cleanup(dir);
});

test("empty repo: 0-source-files warning, degraded false, edgeCoverage null", () => {
  const dir = makeRepo({ "README.md": "# no source here\n" });
  gitInit(dir, { commit: true });
  const r = runErr(dir);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /0 source files found/, "must warn when no source files are found");
  const m = readMap(dir);
  assert.equal(m.fileCount, 0);
  assert.equal(m.degraded, false);
  assert.equal(m.edgeCoverage, null);
  cleanup(dir);
});

test("healthy repo: no warning, degraded:false, high edgeCoverage, existing fields intact", () => {
  const dir = makeRepo(healthyRepo());
  gitInit(dir, { commit: true });
  const r = runErr(dir);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /import edge|most imports unresolved|0 source files found/,
    "a healthy repo must never print the degraded/empty warnings");
  const m = readMap(dir);
  assert.equal(m.degraded, false, "healthy repo must not be flagged degraded");
  assert.equal(m.edgeCoverage, 1, "every relative import resolves → coverage 1");
  assert.ok(m.fileCount > 10);
  // Byte-safety: dropping the two NEW keys must leave a map with exactly the
  // pre-existing top-level shape (no field renamed/removed/reordered semantically).
  const { edgeCoverage, degraded, ...rest } = m;
  assert.deepEqual(
    Object.keys(rest),
    ["schema", "generatedSha", "dirty", "fileCount", "hubs", "features", "rankedSymbols", "lexical", "files"],
    "pre-existing top-level keys must be unchanged when the two new keys are removed (plus the additive `lexical` index)",
  );
  cleanup(dir);
});

// A repo full of node_modules (bare-package) imports must NOT be counted as
// degraded — bare specifiers are external by design and excluded from the
// coverage denominator, so a React/Next-heavy healthy repo never false-positives.
test("bare-package imports are excluded from coverage (no false degraded)", () => {
  const files = {
    "node_modules/leftpad/package.json": '{"name":"leftpad","version":"1.0.0","main":"index.js"}\n',
    "node_modules/leftpad/index.js": "export function leftpad(s){ return s; }\n",
    "src/base.js": "export function base(){ return 0; }\n",
  };
  // 12 files that each import a bare package AND a resolving relative module.
  for (let i = 1; i <= 12; i++) {
    files[`src/f${i}.js`] =
      `import { leftpad } from "leftpad";\nimport { base } from "./base";\nexport function f${i}(){ return leftpad(base()); }\n`;
  }
  const dir = makeRepo(files);
  gitInit(dir, { commit: true });
  const r = runErr(dir);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /most imports unresolved/, "bare-package imports must not trigger the degraded warning");
  const m = readMap(dir);
  assert.equal(m.degraded, false);
  assert.equal(m.edgeCoverage, 1, "only the resolving relative './base' imports count → coverage 1");
  cleanup(dir);
});
