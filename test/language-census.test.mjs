// The language census — the demand instrument (ROADMAP Phase 1A).
//
// The old gate ("wait until someone asks for Python") could not fire: a user
// whose repo agentmap cannot read gets a useless map and leaves without filing
// anything. The census inverts it — count what is in the repo, and when an
// unsupported language dominates, say so and point at one countable place.
//
// The two failure modes this file guards are opposite and both bad: staying
// silent on a repo that is obviously the wrong fit, and nagging a repo that is
// perfectly fine. The share threshold is what separates them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeRepo, gitInit, run, runErr, cleanup, AGENTMAP } from "./helpers.mjs";

const py = (n) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`src/m${i}.py`, `def f${i}():\n    pass\n`]),
);
const ts = (n) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`src/t${i}.ts`, `export const t${i} = ${i};\n`]),
);

test("a Python-dominant repo is told, with counts and a vote link", () => {
  const dir = makeRepo({ ...py(8), ...ts(1) });
  try {
    gitInit(dir, { commit: true });
    const { stderr } = runErr(dir, "--hubs");
    assert.match(stderr, /8 Python files/);
    assert.match(stderr, /89% of this repo/);
    assert.match(stderr, /TS\/JS-only/);
    assert.match(stderr, /issues\/43/, "must point at exactly one countable place");
  } finally { cleanup(dir); }
});

test("a TS repo with a few foreign scripts stays silent", () => {
  // The nagging failure mode. A build script or two must not trip the census.
  const dir = makeRepo({ ...ts(20), "scripts/gen.py": "print(1)\n" });
  try {
    gitInit(dir, { commit: true });
    const { stderr } = runErr(dir, "--hubs");
    assert.doesNotMatch(stderr, /not indexed/, `census fired on a 1-in-21 repo:\n${stderr}`);
  } finally { cleanup(dir); }
});

test("docs and data never tip the census", () => {
  // Only code counts. A repo of 30 markdown files and 3 .ts files is a TS repo.
  const dir = makeRepo({
    ...ts(3),
    ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`docs/d${i}.md`, "# x\n"])),
    "data.json": "{}\n",
  });
  try {
    gitInit(dir, { commit: true });
    const { stderr } = runErr(dir, "--hubs");
    assert.doesNotMatch(stderr, /not indexed/, `non-code files tipped the census:\n${stderr}`);
  } finally { cleanup(dir); }
});

test("the dominant language wins, not the first one seen", () => {
  const dir = makeRepo({ ...py(2), "src/a.go": "package main\n", "src/b.go": "package main\n", "src/c.go": "package main\n", "src/d.go": "package main\n" });
  try {
    gitInit(dir, { commit: true });
    const { stderr } = runErr(dir, "--hubs");
    assert.match(stderr, /4 Go files/);
    assert.doesNotMatch(stderr, /Want Python\?/);
  } finally { cleanup(dir); }
});

test("AGENTMAP_NO_CENSUS=1 silences it", () => {
  // Asserted by actually setting the variable. helpers.runErr does not thread
  // env, so this spawns directly — checking only that the message *mentions* the
  // flag would test the string, not the behaviour it promises.
  const dir = makeRepo({ ...py(8), ...ts(1) });
  try {
    gitInit(dir, { commit: true });
    const loud = runErr(dir, "--hubs");
    assert.match(loud.stderr, /Python/, "precondition: census fires without the opt-out");
    assert.match(loud.stderr, /AGENTMAP_NO_CENSUS=1/, "the message must state how to silence it");

    const quiet = spawnSync(process.execPath, [AGENTMAP, "--hubs"], {
      cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, AGENTMAP_NO_CENSUS: "1" },
    });
    assert.doesNotMatch(quiet.stderr ?? "", /not indexed/, "the documented opt-out did not silence the census");
  } finally { cleanup(dir); }
});

test("the census never pollutes stdout or --json", () => {
  // stdout is a data contract — an agent parses it. The census is advisory and
  // belongs on stderr, or it would corrupt every JSON consumer.
  const dir = makeRepo({ ...py(8), ...ts(1) });
  try {
    gitInit(dir, { commit: true });
    const r = run(dir, "--hubs", "--json");
    assert.doesNotMatch(r.stdout, /not indexed/);
    assert.doesNotThrow(() => JSON.parse(r.stdout), "census broke --json output");
  } finally { cleanup(dir); }
});
