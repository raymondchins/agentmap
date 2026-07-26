// JSX elements are call sites.
//
// `<Foo />` compiles to `React.createElement(Foo, …)` (classic) or `jsx(Foo, …)`
// (automatic), so a user asking "who calls Container" means the components that
// render it. Both call-graph directions used to collect only CallExpression /
// NewExpression, so every React component reported UNDER-COUNTED callers and
// often zero outgoing calls — while still exiting 0 under the "compiler-accurate,
// not tree-sitter name-matching" label in mcp.mjs:81.
//
// Measured on a real React repo before the fix: `--callers Container` returned
// 0 call sites; after, 43. That is the failure this file exists to prevent
// coming back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const APP = {
  "src/Container.tsx":
    "export function Container({ children }: { children?: unknown }) {\n  return children;\n}\n",
  // Renders it with children — <Container>…</Container>
  "src/Page.tsx":
    'import { Container } from "./Container";\nexport const Page = () => <Container>hello</Container>;\n',
  // Renders it self-closing — <Container />
  "src/Other.tsx":
    'import { Container } from "./Container";\nexport const Other = () => <Container />;\n',
  // Plain call, the one form that always worked.
  "src/Direct.ts":
    'import { Container } from "./Container";\nexport const d = Container({});\n',
  // Only intrinsic tags — must NOT produce in-project edges.
  "src/Plain.tsx": "export const Plain = () => <div>x</div>;\n",
};

test("--callers counts JSX usages, not just plain calls", () => {
  const dir = makeRepo(APP);
  try {
    gitInit(dir, { commit: true });
    const out = run(dir, "--callers", "Container").stdout;
    assert.match(out, /3 call sites/, `expected 3 (1 call + 2 JSX), got:\n${out}`);
    assert.match(out, /src\/Direct\.ts/);
    assert.match(out, /src\/Page\.tsx/, "missed <Container>…</Container>");
    assert.match(out, /src\/Other\.tsx/, "missed <Container />");
  } finally { cleanup(dir); }
});

test("--callers attributes a JSX usage to its enclosing component", () => {
  const dir = makeRepo(APP);
  try {
    gitInit(dir, { commit: true });
    const r = JSON.parse(run(dir, "--callers", "Container", "--json").stdout);
    const byFile = Object.fromEntries(r.callers.map((c) => [c.file, c.caller]));
    assert.equal(byFile["src/Page.tsx"], "Page");
    assert.equal(byFile["src/Other.tsx"], "Other");
  } finally { cleanup(dir); }
});

test("--callers counts <Foo>…</Foo> once, not twice", () => {
  // The closing tag is the same call site; collecting JsxClosingElement too
  // would double-count every non-self-closing element.
  const dir = makeRepo({
    "src/Container.tsx": "export function Container({ children }: { children?: unknown }) {\n  return children;\n}\n",
    "src/Multi.tsx":
      'import { Container } from "./Container";\nexport const Multi = () => (\n  <Container>\n    <span>x</span>\n  </Container>\n);\n',
  });
  try {
    gitInit(dir, { commit: true });
    const r = JSON.parse(run(dir, "--callers", "Container", "--json").stdout);
    assert.equal(r.total, 1, `a single multi-line element must be 1 site, got ${r.total}`);
  } finally { cleanup(dir); }
});

test("--calls resolves the components a component renders", () => {
  const dir = makeRepo(APP);
  try {
    gitInit(dir, { commit: true });
    const out = run(dir, "--calls", "Page").stdout;
    assert.match(out, /1 in-project target/, `Page renders <Container>; got:\n${out}`);
    assert.match(out, /Container/);
  } finally { cleanup(dir); }
});

test("--calls does not fabricate targets for intrinsic tags", () => {
  const dir = makeRepo(APP);
  try {
    gitInit(dir, { commit: true });
    const r = JSON.parse(run(dir, "--calls", "Plain", "--json").stdout);
    assert.equal(r.total, 0, `<div> is not an in-project symbol, got: ${JSON.stringify(r.calls)}`);
  } finally { cleanup(dir); }
});

test("a non-JSX repo is unaffected by the JSX support", () => {
  // Guards the byte-identical promise for the TS/JS-only case: adding JSX kinds
  // to the collectors must not perturb a repo that has none.
  const dir = makeRepo({
    "src/a.ts": "export function a() { return 1; }\n",
    "src/b.ts": 'import { a } from "./a";\nexport function b() { return a(); }\n',
  });
  try {
    gitInit(dir, { commit: true });
    const r = JSON.parse(run(dir, "--callers", "a", "--json").stdout);
    assert.equal(r.total, 1);
    assert.equal(r.callers[0].file, "src/b.ts");
    assert.equal(r.callers[0].caller, "b");
  } finally { cleanup(dir); }
});
