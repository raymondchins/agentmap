// SPDX-License-Identifier: MIT
// ============================================================================
//  Barrel resolution — "the real definition site behind the re-export".
//
//  `getExportedDeclarations()` already walks re-export chains through the type
//  checker, so the origin declaration is materialised on every build and then
//  thrown away. Two things fell out of that:
//
//    1. --find/--any printed a barrel's pass-through entry and the origin's real
//       entry as two undifferentiated hits, so "where do I actually edit this?"
//       had no answer in the output.
//    2. --callers/--calls resolved OWNERSHIP from `reExports`, which is built
//       only from NAMED re-export specifiers. `export * from "./x"` has no
//       specifiers to iterate, so a star barrel was scored as a competing
//       DEFINITION — and one such barrel was enough to make --callers refuse the
//       whole query with error:"ambiguous". `export *` is the most common barrel
//       form in TypeScript, and the flagship compiler-accurate command failed
//       hard on it. Verified pre-fix: --callers Thing → ambiguous, candidates
//       ["src/mid.ts","src/thing.ts"], where src/mid.ts defines nothing at all.
//
//  Both now read the per-export `definedIn` (in-repo origin) / `external: true`
//  (origin outside the repo) fields. Ownership is decided from those, NOT from a
//  widened `reExports` — rankSymbols reads `reExports` to discount pass-through
//  names, so broadening it would silently move symbol ranking.
//
//  Run: node --test test/barrel-resolution.test.mjs
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

// thing.ts defines Thing. Every other src file re-exports it a different way.
function barrelRepo(extra = {}) {
  return {
    "src/thing.ts":
      "export function Thing() { return 1; }\n" +
      "export type ThingType = { a: number };\n" +
      "export default function DefaultThing() { return 2; }\n",

    "src/star.ts": 'export * from "./thing";\n',                       // star, 1 hop
    "src/outer.ts": 'export * from "./star";\n',                       // star, 2 hops
    "src/named.ts": 'export { Thing } from "./thing";\n',              // named
    "src/renamed.ts": 'export { Thing as Renamed } from "./thing";\n', // renamed
    "src/typed.ts": 'export type { ThingType } from "./thing";\n',     // type-only
    "src/plain.ts": "export function Plain() { return 3; }\n",         // defines, never re-exports
    ...extra,
  };
}

const findJson = (dir, sym) => JSON.parse(run(dir, "--find", sym, "--json").stdout);
const entry = (json, file, name) => json.matches.find((m) => m.file === file && m.name === name);

test("a star re-export reports the real definition site, the origin does not", () => {
  const dir = makeRepo(barrelRepo());
  gitInit(dir, { commit: true });
  try {
    const j = findJson(dir, "Thing");

    const viaStar = entry(j, "src/star.ts", "Thing");
    assert.ok(viaStar, "star barrel did not surface Thing at all");
    assert.equal(viaStar.definedIn, "src/thing.ts");

    const origin = entry(j, "src/thing.ts", "Thing");
    assert.ok(origin, "origin file did not surface Thing");
    assert.ok(!("definedIn" in origin),
      "a real definition must carry no definedIn — otherwise every export in every repo grows a self-referential field");
  } finally { cleanup(dir); }
});

test("a 2-hop star chain resolves to the ultimate origin, not the middle barrel", () => {
  // outer.ts → star.ts → thing.ts. Reporting star.ts would be a half-answer that
  // still sends an agent to a file with no code in it.
  const dir = makeRepo(barrelRepo());
  gitInit(dir, { commit: true });
  try {
    assert.equal(entry(findJson(dir, "Thing"), "src/outer.ts", "Thing").definedIn, "src/thing.ts");
  } finally { cleanup(dir); }
});

test("named and renamed re-exports both resolve to the origin", () => {
  const dir = makeRepo(barrelRepo());
  gitInit(dir, { commit: true });
  try {
    assert.equal(entry(findJson(dir, "Thing"), "src/named.ts", "Thing").definedIn, "src/thing.ts");
    // The local name differs from the origin name — resolution must follow the
    // declaration, not string-match the identifier.
    assert.equal(entry(findJson(dir, "Renamed"), "src/renamed.ts", "Renamed").definedIn, "src/thing.ts");
  } finally { cleanup(dir); }
});

test("a type-only re-export still resolves, though it forms no runtime edge", () => {
  // `export type { T } from` is skipped by the edge builder, so nothing in
  // imports/reExportsFrom could answer this — it has to come from the checker.
  const dir = makeRepo(barrelRepo());
  gitInit(dir, { commit: true });
  try {
    assert.equal(entry(findJson(dir, "ThingType"), "src/typed.ts", "ThingType").definedIn, "src/thing.ts");
  } finally { cleanup(dir); }
});

test("a re-export from a dependency is marked external, never a node_modules path", () => {
  // The graph has no node inside node_modules to point at, so emitting a path
  // there would hand an agent a file it must not read or edit.
  const dir = makeRepo(barrelRepo({
    "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js", types: "index.d.ts" }),
    "node_modules/dep/index.d.ts": "export declare function depFn(): number;\n",
    "node_modules/dep/index.js": "export function depFn() { return 9; }\n",
    "src/fromDep.ts": 'export { depFn } from "dep";\n',
  }));
  gitInit(dir, { commit: true });
  try {
    const r = run(dir, "--find", "depFn", "--json");
    assert.ok(!/node_modules/.test(r.stdout), `a node_modules path leaked into --find output:\n${r.stdout}`);
    const e = entry(JSON.parse(r.stdout), "src/fromDep.ts", "depFn");
    assert.ok(e, "re-export of a dependency symbol did not surface");
    assert.equal(e.external, true);
    assert.ok(!("definedIn" in e), "external origins must not also carry an in-repo path");
  } finally { cleanup(dir); }
});

test("mutually circular star barrels terminate and attribute correctly", () => {
  const dir = makeRepo({
    "src/circA.ts": 'export * from "./circB";\nexport function OnlyA() { return 1; }\n',
    "src/circB.ts": 'export * from "./circA";\nexport function OnlyB() { return 2; }\n',
  });
  gitInit(dir, { commit: true });
  try {
    const a = findJson(dir, "OnlyA");
    assert.ok(!("definedIn" in entry(a, "src/circA.ts", "OnlyA")), "circA defines OnlyA — must not be marked a re-export");
    assert.equal(entry(a, "src/circB.ts", "OnlyA").definedIn, "src/circA.ts");
  } finally { cleanup(dir); }
});

// ─── The --callers ownership fix ─────────────────────────────────────────────

test("a star barrel no longer makes --callers report the symbol as ambiguous", () => {
  // The regression that motivated this file: src/star.ts and src/outer.ts are
  // pure pass-throughs, yet each was counted as a definition of Thing.
  const dir = makeRepo({
    ...barrelRepo(),
    "consumer.ts": 'import { Thing } from "./src/star";\nexport function use() { return Thing(); }\n',
  });
  gitInit(dir, { commit: true });
  try {
    const r = run(dir, "--callers", "Thing", "--json");
    const j = JSON.parse(r.stdout);
    assert.notEqual(j.error, "ambiguous",
      `star barrels were counted as definitions: ${JSON.stringify(j.candidates)}`);
    assert.equal(j.file, "src/thing.ts", "ownership did not land on the file that actually defines Thing");
    assert.equal(r.status, 0);
    assert.ok(j.callers.some((c) => c.file === "consumer.ts"),
      `the real caller was not found: ${JSON.stringify(j.callers)}`);
  } finally { cleanup(dir); }
});

test("an UNRESOLVABLE re-export is still a re-export, not a rival definition", () => {
  // Found on radix-ui/primitives@579c5b84: packages/react/radix-ui/src/internal.ts
  // forwards names from workspace packages, and with no node_modules installed the
  // specifier resolves to nothing — so neither `definedIn` nor the resolved-path
  // branch of `reExports` fired, and the file was scored as a definer of every
  // name it merely forwards. Whether a specifier resolves is an environment fact;
  // whether the syntax declares a name is not.
  const dir = makeRepo({
    "src/real.ts": "export function Widget() { return 1; }\n",
    "src/forward.ts": 'export { Widget } from "@scope/never-installed";\n',
  });
  gitInit(dir, { commit: true });
  try {
    const j = JSON.parse(run(dir, "--callers", "Widget", "--json").stdout);
    assert.notEqual(j.error, "ambiguous",
      `an unresolvable forward was counted as a definition: ${JSON.stringify(j.candidates)}`);
    assert.equal(j.file, "src/real.ts");
  } finally { cleanup(dir); }
});

test("`export { local }` with no `from` still counts as a definition", () => {
  // The guard on the fix above: only a specifier makes an export a forward. This
  // is the shape radix's internal.ts uses for the symbol it really does declare.
  const dir = makeRepo({
    "src/decl.ts": "const Thing = 1;\nexport { Thing };\n",
    "src/user.ts": 'import { Thing } from "./decl";\nexport const v = Thing;\n',
  });
  gitInit(dir, { commit: true });
  try {
    const j = JSON.parse(run(dir, "--callers", "Thing", "--json").stdout);
    assert.notEqual(j.error, "no match", "a locally-declared export was mistaken for a pass-through");
    assert.equal(j.file, "src/decl.ts");
  } finally { cleanup(dir); }
});

test("genuinely ambiguous symbols are still reported as ambiguous", () => {
  // The fix must narrow ownership to non-definers only — two files that each
  // really define `dup` must keep failing loudly rather than silently picking one.
  const dir = makeRepo({
    "src/one.ts": "export function dup() { return 1; }\n",
    "src/two.ts": "export function dup() { return 2; }\n",
  });
  gitInit(dir, { commit: true });
  try {
    const j = JSON.parse(run(dir, "--callers", "dup", "--json").stdout);
    assert.equal(j.error, "ambiguous");
    assert.deepEqual(j.candidates.sort(), ["src/one.ts", "src/two.ts"]);
  } finally { cleanup(dir); }
});

// ─── Surface parity + no-bloat guarantee ─────────────────────────────────────

test("--relates and --any carry the same annotation as --find", () => {
  // --relates spreads f.exports directly, but --any re-projects {file,name,kind}
  // in a separate code path that has drifted from --find before.
  const dir = makeRepo(barrelRepo());
  gitInit(dir, { commit: true });
  try {
    const rel = JSON.parse(run(dir, "--relates", "src/star.ts", "--json").stdout);
    assert.equal(rel.exports.find((e) => e.name === "Thing").definedIn, "src/thing.ts");

    // --any routes to a file hit when the query also matches a filename, and to a
    // symbol hit otherwise — the annotation has to survive both projections.
    const any = JSON.parse(run(dir, "--any", "Thing", "--json").stdout);
    const m = [...(any.matches || []), ...(any.symbols || [])]
      .find((x) => x.file === "src/star.ts" && x.name === "Thing");
    assert.ok(m, `--any did not surface the barrel entry: ${JSON.stringify(any).slice(0, 400)}`);
    assert.equal(m.definedIn, "src/thing.ts");
  } finally { cleanup(dir); }
});

test("prose output names the origin file, not just the JSON mode", () => {
  const dir = makeRepo(barrelRepo());
  gitInit(dir, { commit: true });
  try {
    assert.match(run(dir, "--find", "Thing").stdout, /src\/star\.ts.*src\/thing\.ts/);
  } finally { cleanup(dir); }
});

test("a repo with no barrels gains no new bytes in map.json", () => {
  // The 99% case. `definedIn` is spread conditionally, so a barrel-free repo must
  // serialise exactly as it did before the feature existed.
  const dir = makeRepo({
    "src/a.ts": "export function A() { return 1; }\n",
    "src/b.ts": 'import { A } from "./a";\nexport function B() { return A(); }\n',
  });
  gitInit(dir, { commit: true });
  try {
    run(dir, "--map");
    const raw = run(dir, "--relates", "src/a.ts", "--json").stdout;
    assert.ok(!/definedIn|external/.test(raw), `annotation leaked into a barrel-free repo:\n${raw}`);
  } finally { cleanup(dir); }
});
