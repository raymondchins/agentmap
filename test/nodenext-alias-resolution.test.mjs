// A NodeNext import writes the EMITTED specifier — `./consts.js` for `consts.ts`.
// Through a tsconfig `paths` alias, that combination used to resolve to nothing.
//
// Why it mattered more than it looks: ts-morph's own specifier resolution handles
// the relative form, so `./consts.js` was fine. But a per-package alias (`~/*`
// declared in a sub-package's tsconfig, invisible to the root tsconfig) is resolved
// by agentmap's OWN ladder — `resolveAlias` -> `tryResolveAt` — and nothing else.
// That ladder tried the bare path, then `.ts`, then `/index.ts`, and never stripped
// the `.js`. So in a monorepo where the sub-package aliases its own src, every
// aliased import written NodeNext-style produced no edge at all, and the imported
// file reported `dependents (0)` — indistinguishable from a genuine orphan.
//
// Measured on t3-oss/create-t3-app before the fix: 32 import edges resolved across
// 179 files, and `--relates cli/src/consts.ts` returned 0 dependents against 17
// real importers found by grep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// The sub-package declares the alias, so it is NOT visible from the root tsconfig —
// which is what forces resolution through agentmap's ladder rather than ts-morph's.
const monorepo = (extra = {}) => ({
  "package.json": '{ "name": "root", "private": true, "workspaces": ["cli"] }',
  "tsconfig.json": '{ "compilerOptions": { "module": "nodenext", "moduleResolution": "nodenext" } }',
  "cli/package.json": '{ "name": "cli", "version": "1.0.0", "type": "module" }',
  "cli/tsconfig.json":
    '{ "compilerOptions": { "module": "nodenext", "moduleResolution": "nodenext", "baseUrl": ".", "paths": { "~/*": ["./src/*"] } } }',
  "cli/src/consts.ts": "export const X = 1;\n",
  ...extra,
});

const dependentsOf = (dir, file) =>
  JSON.parse(run(dir, "--relates", file, "--json").stdout).dependents;

test("aliased NodeNext specifier (~/consts.js) resolves to the .ts source", () => {
  const dir = makeRepo(monorepo({
    "cli/src/aliasJs.ts": 'import { X } from "~/consts.js";\nexport const a = X;\n',
    "cli/src/aliasNoJs.ts": 'import { X } from "~/consts";\nexport const b = X;\n',
    "cli/src/relJs.ts": 'import { X } from "./consts.js";\nexport const c = X;\n',
  }));
  try {
    gitInit(dir, { commit: true });
    // All three are real importers. Before the fix only the middle two resolved,
    // isolating alias + emitted-extension as the sole failing combination.
    assert.deepEqual(
      dependentsOf(dir, "cli/src/consts.ts").sort(),
      ["cli/src/aliasJs.ts", "cli/src/aliasNoJs.ts", "cli/src/relJs.ts"],
    );
  } finally { cleanup(dir); }
});

test("the other emitted extensions resolve too", () => {
  const dir = makeRepo(monorepo({
    "cli/src/m.mts": "export const M = 1;\n",
    "cli/src/c.cts": "export const C = 1;\n",
    "cli/src/x.tsx": "export const T = 1;\n",
    "cli/src/useMjs.ts": 'import { M } from "~/m.mjs";\nexport const a = M;\n',
    "cli/src/useCjs.ts": 'import { C } from "~/c.cjs";\nexport const b = C;\n',
    "cli/src/useJsx.ts": 'import { T } from "~/x.jsx";\nexport const c = T;\n',
  }));
  try {
    gitInit(dir, { commit: true });
    assert.deepEqual(dependentsOf(dir, "cli/src/m.mts"), ["cli/src/useMjs.ts"]);
    assert.deepEqual(dependentsOf(dir, "cli/src/c.cts"), ["cli/src/useCjs.ts"]);
    assert.deepEqual(dependentsOf(dir, "cli/src/x.tsx"), ["cli/src/useJsx.ts"]);
  } finally { cleanup(dir); }
});

test("a real .js file still wins over a .ts sibling of the same name", () => {
  // The rung must be a LAST resort, not a rewrite: the literal path is tried first,
  // so a mixed repo that genuinely ships `helper.js` next to `helper.ts` keeps
  // pointing at the file the import actually names.
  const dir = makeRepo(monorepo({
    "cli/src/helper.js": "export const H = 'js';\n",
    "cli/src/helper.ts": "export const H = 'ts';\n",
    "cli/src/useHelper.ts": 'import { H } from "~/helper.js";\nexport const a = H;\n',
  }));
  try {
    gitInit(dir, { commit: true });
    assert.deepEqual(dependentsOf(dir, "cli/src/helper.js"), ["cli/src/useHelper.ts"]);
    assert.deepEqual(dependentsOf(dir, "cli/src/helper.ts"), []);
  } finally { cleanup(dir); }
});
