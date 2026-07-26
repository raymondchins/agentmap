// Every file that carries a version number must agree with package.json.
//
// publish.yml gates the tag against package.json AND server.json, so those two
// can never ship out of sync — but .claude-plugin/plugin.json is in no gate at
// all, and it silently sat at 0.14.0 while the package shipped 0.15.0, 0.15.1,
// 0.16.0 and 0.16.1. Nothing failed, because nothing looked. The marketplace
// entry is what users see, so the drift was user-visible the whole time.
//
// This runs in `npm test`, which is the earliest possible feedback — the publish
// gate only fires once a tag is already pushed, and recovering from that means
// deleting and moving a published tag (as this project just had to do).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const VERSION = read("package.json").version;

test("package.json version is a bare semver", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+(-[\w.]+)?$/, `unexpected version: ${VERSION}`);
});

test("server.json tracks package.json (both fields)", () => {
  const sj = read("server.json");
  assert.equal(sj.version, VERSION, "server.json .version drifted from package.json");
  assert.equal(
    sj.packages[0].version, VERSION,
    "server.json .packages[0].version drifted — the MCP Registry would list a version that does not match the npm tarball",
  );
});

test(".claude-plugin/plugin.json tracks package.json", () => {
  assert.equal(
    read(".claude-plugin/plugin.json").version, VERSION,
    "plugin.json drifted from package.json — this is the version shown in the Claude Code marketplace",
  );
});

test("the Node engines floor and the README badge agree", () => {
  // The badge is the first thing a visitor reads, and it claimed >=18 for the
  // entire life of the >=20 breaking change.
  const engines = read("package.json").engines?.node ?? "";
  const floor = engines.match(/(\d+)/)?.[1];
  assert.ok(floor, `could not parse an engines.node floor from ${JSON.stringify(engines)}`);

  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const badge = readme.match(/badge\/node-%3E%3D(\d+)-/);
  assert.ok(badge, "README node badge not found — if the badge URL changed, update this test");
  assert.equal(
    badge[1], floor,
    `README badge says node >=${badge[1]} but package.json engines says >=${floor}`,
  );
});
