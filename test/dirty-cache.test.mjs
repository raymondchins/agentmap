// SPDX-License-Identifier: MIT
// ============================================================================
//  Batch 3 Tier 1 — dirty-map cache. On a dirty git tree, back-to-back queries
//  must reuse ONE rebuild (cached to .claude/agentmap/map.dirty.json, keyed by a
//  fingerprint of the dirty file set) instead of re-parsing the whole repo every
//  call. The clean map.json is never clobbered by a dirty build, so the
//  dirty→clean transition serves the clean cache with no extra rebuild (this also
//  closes the old cache-poison bug).
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, gitInit, git, run, runErr, didReparse, writeFiles, cleanup } from "./helpers.mjs";

const MAP_DIRTY = ".claude/agentmap/map.dirty.json";

// A small but non-trivial repo: an import chain + a default export so the graph
// and symbol ranking have something to chew on.
const BASE = {
  "a.ts": "export const a = 1;\nexport default function widget() { return a; }\n",
  "b.ts": "import widget, { a } from './a';\nexport const b = a + widget();\n",
  "c.ts": "import { b } from './b';\nexport const c = b + 1;\n",
};

test("dirty tree: back-to-back queries reuse ONE rebuild (cache hit, identical output)", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    run(dir, "--hubs");                                   // clean prime → map.json
    assert.ok(!existsSync(join(dir, MAP_DIRTY)), "clean prime must not write map.dirty.json");

    writeFiles(dir, { "b.ts": "import widget, { a } from './a';\nexport const b = a + widget() + 1; // edit\n" });

    const r1 = runErr(dir, "--map", "--json");            // dirty #1
    assert.ok(didReparse(r1), "dirty query #1 must rebuild");
    assert.ok(existsSync(join(dir, MAP_DIRTY)), "dirty build must write map.dirty.json");

    const r2 = runErr(dir, "--map", "--json");            // dirty #2, same state
    assert.ok(!didReparse(r2), "dirty query #2 on an unchanged tree must be a cache hit (no reparse)");
    assert.equal(r1.stdout, r2.stdout, "dirty cache must serve byte-identical output");
  } finally { cleanup(dir); }
});

test("dirty cache invalidates when the dirty file set changes", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    run(dir, "--hubs");
    writeFiles(dir, { "b.ts": "import { a } from './a';\nexport const b = a; // v1\n" });
    assert.ok(didReparse(runErr(dir, "--map", "--json")), "first dirty build");
    assert.ok(!didReparse(runErr(dir, "--map", "--json")), "cache hit on unchanged dirty tree");
    // a further edit ⇒ different fingerprint ⇒ must rebuild
    writeFiles(dir, { "b.ts": "import { a } from './a';\nexport const b = a; // v2 changed\n" });
    assert.ok(didReparse(runErr(dir, "--map", "--json")), "a further edit must invalidate the dirty cache");
  } finally { cleanup(dir); }
});

test("dirty→clean transition serves the clean cache with no extra rebuild (poison fix)", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    run(dir, "--hubs");                                   // clean map.json (dirty:0)
    writeFiles(dir, { "b.ts": "import { a } from './a';\nexport const b = a; // temp edit\n" });
    assert.ok(didReparse(runErr(dir, "--map", "--json")), "dirty build happened");
    git(dir, "checkout", "--", "b.ts");                   // revert → clean tree
    assert.ok(!didReparse(runErr(dir, "--map", "--json")),
      "reverted-to-clean must serve the untouched clean map.json (no rebuild)");
  } finally { cleanup(dir); }
});

test("moving HEAD while a file stays dirty invalidates the dirty cache", () => {
  const dir = makeRepo(BASE);
  try {
    gitInit(dir, { commit: true });
    run(dir, "--hubs");
    writeFiles(dir, { "b.ts": "import { a } from './a';\nexport const b = a; // dirty\n" });
    assert.ok(didReparse(runErr(dir, "--map", "--json")), "dirty build at HEAD1");
    assert.ok(!didReparse(runErr(dir, "--map", "--json")), "cache hit at HEAD1");
    // move HEAD (commit a different new file) while b.ts stays dirty
    writeFiles(dir, { "d.ts": "export const d = 1;\n" });
    git(dir, "add", "d.ts");
    git(dir, "commit", "-q", "-m", "add d", "--no-verify");
    assert.ok(didReparse(runErr(dir, "--map", "--json")),
      "HEAD move must invalidate the dirty cache (fingerprint includes HEAD)");
  } finally { cleanup(dir); }
});
