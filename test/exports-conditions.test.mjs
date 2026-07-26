// SPDX-License-Identifier: MIT
// ============================================================================
//  package.json `exports` — subpath patterns, nested conditions, array fallbacks.
//
//  Cross-package edges in a workspace go through a package's declared `exports`
//  map. Two shapes Node supports were unsupported here, and both failed the same
//  silent way — no edge, exit 0, no warning:
//
//    • Subpath PATTERNS ("./wild/*": "./src/wild/*.ts") — the lookup was exact-key
//      only, so every wildcard subpath produced nothing.
//    • NESTED conditions ({"node": {"import": "./src/x.ts"}}) — the reader only
//      looked one level down and gave up when no top-level value was a string.
//
//  Condition precedence here is deliberately SOURCE-first (types → typings →
//  import → default), not Node's runtime precedence: this tool never executes the
//  package, and the published runtime target usually points at a gitignored dist/.
//  That reasoning is the same one behind resolving `main`→source in 05ef8dc.
//
//  Run: node --test test/exports-conditions.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// A two-package workspace: pkg-a publishes an exports map, pkg-b imports through it.
function ws(exportsMap, aFiles, consumerBody) {
  return {
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
    "packages/pkg-a/package.json": JSON.stringify({ name: "@acme/a", version: "1.0.0", exports: exportsMap }),
    "packages/pkg-b/package.json": JSON.stringify({ name: "@acme/b", version: "1.0.0" }),
    "packages/pkg-b/src/consumer.ts": consumerBody,
    ...aFiles,
  };
}

const dependentsOf = (dir, file) => JSON.parse(run(dir, "--relates", file, "--json").stdout).dependents;

test("a wildcard subpath pattern forms a cross-package edge", () => {
  const dir = makeRepo(ws(
    { "./wild/*": "./src/wild/*.ts" },
    { "packages/pkg-a/src/wild/foo.ts": "export const foo = 1;\n" },
    'import { foo } from "@acme/a/wild/foo";\nexport const v = foo;\n',
  ));
  gitInit(dir, { commit: true });
  try {
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/wild/foo.ts"), ["packages/pkg-b/src/consumer.ts"]);
  } finally { cleanup(dir); }
});

test("the longest matching pattern prefix wins, as it does in Node", () => {
  const dir = makeRepo(ws(
    { "./*": "./src/generic/*.ts", "./deep/*": "./src/deep/*.ts" },
    {
      "packages/pkg-a/src/generic/x.ts": "export const g = 1;\n",
      "packages/pkg-a/src/deep/x.ts": "export const d = 1;\n",
    },
    'import { d } from "@acme/a/deep/x";\nexport const v = d;\n',
  ));
  gitInit(dir, { commit: true });
  try {
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/deep/x.ts"), ["packages/pkg-b/src/consumer.ts"],
      "the more specific ./deep/* pattern lost to the catch-all ./*");
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/generic/x.ts"), []);
  } finally { cleanup(dir); }
});

test("on an equal-length prefix tie, the longer full key wins — as Node does", () => {
  // Verified against real Node v26: patternKeyCompare ranks by prefix length, then
  // by TOTAL key length. Declaration order never decides. Node's own docs pair
  // "./lib/*" with "./lib/*.js" for extension-optional exports, so this tie is a
  // documented idiom, not a corner case — resolving it by key order picks the
  // wrong file and leaves the right one looking like an orphan.
  const dir = makeRepo(ws(
    { "./foo/*": "./src/foo-a/*.ts", "./foo/*x": "./src/foo-b/*.ts" },
    {
      "packages/pkg-a/src/foo-a/barx.ts": "export const a = 1;\n",
      "packages/pkg-a/src/foo-b/bar.ts": "export const b = 1;\n",
    },
    'import { b } from "@acme/a/foo/barx";\nexport const v = b;\n',
  ));
  gitInit(dir, { commit: true });
  try {
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/foo-b/bar.ts"), ["packages/pkg-b/src/consumer.ts"],
      'the "./foo/*x" pattern lost the tie to "./foo/*", which was merely declared first');
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/foo-a/barx.ts"), []);
  } finally { cleanup(dir); }
});

test("a wildcard that would match nothing forms no edge", () => {
  // Node raises ERR_PACKAGE_PATH_NOT_EXPORTED when the specifier is exactly
  // prefix+suffix with nothing in between. Accepting it would claim an import
  // resolves when it actually throws — the opposite of what a blast-radius tool
  // is for.
  const dir = makeRepo(ws(
    { "./a*b": "./src/*.ts" },
    { "packages/pkg-a/src/.ts": "export const empty = 1;\n" },
    'import { empty } from "@acme/a/ab";\nexport const v = empty;\n',
  ));
  gitInit(dir, { commit: true });
  try {
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/.ts"), [],
      "an empty wildcard fill fabricated an edge for an import Node would reject");
  } finally { cleanup(dir); }
});

test("a nested condition object resolves at any depth", () => {
  const dir = makeRepo(ws(
    { "./nested": { node: { import: "./src/nested.ts" } } },
    { "packages/pkg-a/src/nested.ts": "export const n = 1;\n" },
    'import { n } from "@acme/a/nested";\nexport const v = n;\n',
  ));
  gitInit(dir, { commit: true });
  try {
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/nested.ts"), ["packages/pkg-b/src/consumer.ts"]);
  } finally { cleanup(dir); }
});

test("an array target falls back to the first entry that resolves", () => {
  const dir = makeRepo(ws(
    { "./arr": ["./src/missing.ts", "./src/arr.ts"] },
    { "packages/pkg-a/src/arr.ts": "export const a = 1;\n" },
    'import { a } from "@acme/a/arr";\nexport const v = a;\n',
  ));
  gitInit(dir, { commit: true });
  try {
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/arr.ts"), ["packages/pkg-b/src/consumer.ts"]);
  } finally { cleanup(dir); }
});

test("`types` still wins over a runtime condition pointing at unbuilt dist", () => {
  // The 05ef8dc rule, now exercised through a nested object rather than a flat one.
  const dir = makeRepo(ws(
    { ".": { node: { require: "./dist/index.js" }, types: "./src/index.ts" } },
    { "packages/pkg-a/src/index.ts": "export const i = 1;\n" },
    'import { i } from "@acme/a";\nexport const v = i;\n',
  ));
  gitInit(dir, { commit: true });
  try {
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/index.ts"), ["packages/pkg-b/src/consumer.ts"]);
  } finally { cleanup(dir); }
});

test("a null target blocks a subpath without fabricating an edge", () => {
  const dir = makeRepo(ws(
    { "./blocked": null },
    { "packages/pkg-a/src/blocked.ts": "export const b = 1;\n" },
    'export const v = 1;\n',
  ));
  gitInit(dir, { commit: true });
  try {
    assert.deepEqual(dependentsOf(dir, "packages/pkg-a/src/blocked.ts"), []);
  } finally { cleanup(dir); }
});
