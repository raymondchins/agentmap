// SPDX-License-Identifier: MIT
// Node package.json "imports" subpath maps (self-referencing internal specifiers —
// `#internal/*`, `#lib/util`). Node resolves these against the nearest package.json;
// agentmap must form the corresponding dependency edge so blast-radius (--relates)
// and hub ranking see them. Before this feature only tsconfig/vite/workspace aliases
// resolved, so every `#`-prefixed edge was silently dropped. Also proves a repo with
// NO "imports" field stays behaviorally unchanged (byte-safety guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// ---- Fixtures --------------------------------------------------------------

// Wildcard subpath map: `#internal/*` → ./src/internal/*.js (points at the EMITTED
// .js, source is .ts) + an exact `#lib/util` via a conditions object (prefer import).
function importsFixture() {
  return {
    "package.json": JSON.stringify({
      name: "app", version: "1.0.0",
      imports: {
        "#internal/*": "./src/internal/*.js",
        "#lib/util": { import: "./src/lib/util.js", default: "./dist/lib/util.js" },
      },
    }),
    "src/internal/logger.ts": `export function log() { return "l"; }\n`,
    "src/lib/util.ts": `export function util() { return "u"; }\n`,
    "src/app.ts":
      `import { log } from "#internal/logger";\n` +
      `import { util } from "#lib/util";\n` +
      `export const a = log() + util();\n`,
  };
}

// ---- Triggering behavior ---------------------------------------------------

test('pkg imports: wildcard "#internal/*" forms a dependent edge to the .ts source', () => {
  const dir = makeRepo(importsFixture());
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "src/internal/logger.ts");
  assert.equal(r.status, 0, r.stderr);
  // This edge was ZERO before "imports" resolution — proving the `#internal/*` map
  // now resolves through to the emitted-.js→source-.ts extension ladder.
  assert.match(r.stdout, /dependents \(1\): src\/app\.ts/, r.stdout);
  cleanup(dir);
});

test('pkg imports: exact "#lib/util" via a conditions object resolves (prefer import)', () => {
  const dir = makeRepo(importsFixture());
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "src/lib/util.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dependents \(1\): src\/app\.ts/, r.stdout);
  cleanup(dir);
});

// ---- Non-triggering: must stay behaviorally unchanged (byte-safety) ---------

test('repo with NO package.json "imports" field is unaffected — normal relative edges only', () => {
  const dir = makeRepo({
    // package.json present but with no "imports" map — the guard must not fire.
    "package.json": JSON.stringify({ name: "plain", version: "1.0.0" }),
    "src/lib/util.ts": `export function u() { return 1; }\n`,
    "src/app.ts": `import { u } from "./lib/util";\nexport const a = u();\n`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "src/lib/util.ts");
  assert.equal(r.status, 0, r.stderr);
  // The ordinary relative import still forms its edge…
  assert.match(r.stdout, /dependents \(1\): src\/app\.ts/, r.stdout);
  // …and nothing `#`-shaped leaks in.
  assert.doesNotMatch(r.stdout, /#/, r.stdout);
  cleanup(dir);
});

test('a "#foo" import with NO matching "imports" entry does not fabricate an edge', () => {
  // "imports" maps only `#lib/util`; a stray `#missing/x` import must stay unresolved
  // (no target file, no map entry) — the resolver must not invent an edge.
  const dir = makeRepo({
    "package.json": JSON.stringify({
      name: "app", version: "1.0.0",
      imports: { "#lib/util": "./src/lib/util.js" },
    }),
    "src/lib/util.ts": `export function util() { return "u"; }\n`,
    "src/app.ts": `import { x } from "#missing/x";\nexport const a = x;\n`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "src/lib/util.ts");
  assert.equal(r.status, 0, r.stderr);
  // #lib/util is mapped but imported by nobody; #missing/x has no map entry → 0 deps.
  assert.match(r.stdout, /dependents \(0\): —/, r.stdout);
  cleanup(dir);
});
