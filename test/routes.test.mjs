// SPDX-License-Identifier: MIT
// ============================================================================
//  Next.js App Router route table (--routes / --route).
//
//  The bar is a URL you can paste into a browser. That is exactly where a
//  convention-only extractor goes wrong: a `(group)` folder organises the tree
//  and contributes NOTHING to the URL, but it DOES contribute a layout. A table
//  that emits `/(app)/brands/:id` — a path that 404s — is worse than no table,
//  because it looks authoritative. So every assertion here is about the URL
//  being REAL, not merely about a route being found.
//
//  Run: node --test test/routes.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const TSCONFIG = JSON.stringify({
  compilerOptions: { jsx: "react-jsx", moduleResolution: "bundler", module: "esnext", target: "esnext", baseUrl: "." },
});

// Every App Router shape that changes a URL, in one repo.
function repo() {
  return {
    "tsconfig.json": TSCONFIG,
    "app/layout.tsx": "export default function Root({children}:{children:any}){ return <div>{children}</div>; }\n",
    "app/page.tsx": "export default function Home(){ return <main/>; }\n",
    // route GROUP: organisational, must NOT appear in the URL, but DOES add a layout
    "app/(marketing)/layout.tsx": "export default function M({children}:{children:any}){ return <div>{children}</div>; }\n",
    "app/(marketing)/about/page.tsx": "export default function About(){ return <main/>; }\n",
    // dynamic + catch-all + optional catch-all
    "app/blog/[slug]/page.tsx": "export default function Post(){ return <main/>; }\n",
    "app/docs/[...path]/page.tsx": "export default function Docs(){ return <main/>; }\n",
    "app/shop/[[...filter]]/page.tsx": "export default function Shop(){ return <main/>; }\n",
    // API route with several methods — not a page, and NOT layout-wrapped
    "app/api/items/route.ts":
      "export async function GET(){ return new Response('a'); }\n" +
      "export async function POST(){ return new Response('b'); }\n",
    // re-export shim: no `export default function`, so a naive extractor misses it
    "app/v2/about/page.tsx": 'export { default } from "@/app/(marketing)/about/page";\n',
    // parallel-route slot: contributes no URL segment of its own
    "app/dash/@side/page.tsx": "export default function Side(){ return <aside/>; }\n",
  };
}

const json = (dir, ...a) => JSON.parse(run(dir, ...a, "--json").stdout);

test("route groups are stripped from the URL but kept in the layout chain", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const r = json(dir, "--routes");
    const about = r.routes.find((x) => x.file === "app/(marketing)/about/page.tsx");
    assert.equal(about.url, "/about", "a (group) folder must not appear in the URL");
    assert.ok(!r.routes.some((x) => x.url.includes("(")), "no URL may contain a route group");
    // ...but the group's layout still wraps it — that is the whole point of a group.
    assert.deepEqual(about.layoutChain, ["app/layout.tsx", "app/(marketing)/layout.tsx"]);
  } finally { cleanup(dir); }
});

test("dynamic, catch-all and optional-catch-all segments render as real params", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const byFile = Object.fromEntries(json(dir, "--routes").routes.map((r) => [r.file, r.url]));
    assert.equal(byFile["app/blog/[slug]/page.tsx"], "/blog/:slug");
    assert.equal(byFile["app/docs/[...path]/page.tsx"], "/docs/*path");
    assert.equal(byFile["app/shop/[[...filter]]/page.tsx"], "/shop/*filter?");
    assert.ok(!Object.values(byFile).some((u) => /[\[\]]/.test(u)), "no raw brackets may survive into a URL");
  } finally { cleanup(dir); }
});

test("the root page is / and not /page.tsx", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const root = json(dir, "--routes").routes.find((r) => r.file === "app/page.tsx");
    assert.equal(root.url, "/");
  } finally { cleanup(dir); }
});

test("API routes carry their HTTP methods and are NOT layout-wrapped", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const api = json(dir, "--routes").routes.find((r) => r.file === "app/api/items/route.ts");
    assert.equal(api.kind, "route");
    assert.deepEqual(api.methods, ["GET", "POST"]);
    // A layout is a React component composing a tree; an API handler returns a
    // Response and never renders. Claiming a layout chain here would be false.
    assert.deepEqual(api.layoutChain, [], "route.ts is not wrapped by layout.tsx");
  } finally { cleanup(dir); }
});

test("a re-export shim is a real route, aliased to its target", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const shim = json(dir, "--routes").routes.find((r) => r.file === "app/v2/about/page.tsx");
    assert.ok(shim, "`export { default } from` is still a routable page");
    assert.equal(shim.url, "/v2/about");
    assert.match(shim.alias, /about\/page$/);
  } finally { cleanup(dir); }
});

test("a @slot parallel-route folder contributes no URL segment", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const slot = json(dir, "--routes").routes.find((r) => r.file === "app/dash/@side/page.tsx");
    assert.equal(slot.url, "/dash", "@slot is not a URL segment");
  } finally { cleanup(dir); }
});

test("--route resolves a CONCRETE url through a dynamic segment", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const m = json(dir, "--route", "/blog/hello-world").matches;
    assert.equal(m.length, 1);
    assert.equal(m[0].file, "app/blog/[slug]/page.tsx");
    assert.deepEqual(m[0].layoutChain, ["app/layout.tsx"]);
  } finally { cleanup(dir); }
});

test("--route also answers in reverse, from a file path", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const m = json(dir, "--route", "app/(marketing)/about/page.tsx").matches;
    assert.equal(m.length, 1);
    assert.equal(m[0].url, "/about");
  } finally { cleanup(dir); }
});

test("--route on an unknown url exits 1 with an empty match set", () => {
  const dir = makeRepo(repo());
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--route", "/nope/nothing/here", "--json");
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout).matches, []);
  } finally { cleanup(dir); }
});

test("a repo with no app/ directory says so instead of inventing routes", () => {
  const dir = makeRepo({ "src/index.ts": "export const a = 1;\n" });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--routes", "--json");
    assert.equal(r.status, 1);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.routes, []);
    assert.match(j.reason, /App Router/);
  } finally { cleanup(dir); }
});
