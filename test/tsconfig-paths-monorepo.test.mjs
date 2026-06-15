// SPDX-License-Identifier: MIT
// Monorepo tsconfig paths: package-level `#/*` aliases must resolve when agentmap
// runs from repo root (root tsconfig has no paths). CRM repro pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, gitInit, run, cleanup } from "./helpers.mjs";

const WEB_TSCONFIG = JSON.stringify({
  compilerOptions: { allowJs: true, baseUrl: ".", paths: { "#/*": ["./src/*"] } },
  include: ["src/**/*.ts"],
});

const ROOT_TSCONFIG = JSON.stringify({
  compilerOptions: { allowJs: true },
  include: [],
});

function makeMonorepoFixture(extraConsumers = {}) {
  return {
    "tsconfig.json": ROOT_TSCONFIG,
    "apps/web/tsconfig.json": WEB_TSCONFIG,
    "apps/web/src/lib/auth-client.ts": `export function authClientSymbol() { return "auth"; }`,
    "apps/web/src/lib/utils.ts": `export function utilsSymbol() { return "utils"; }`,
    "apps/web/src/orpc/client.ts": `export function orpcClientSymbol() { return "orpc"; }`,
  // TanStack/Vite-style `#/` imports (not `@/`)
    "apps/web/src/pages/login.ts": `import { authClientSymbol } from "#/lib/auth-client";\nexport const login = authClientSymbol;`,
    "apps/web/src/pages/settings.ts": `import { authClientSymbol } from "#/lib/auth-client";\nexport const settings = authClientSymbol;`,
    "apps/web/src/components/Header.ts": `import { authClientSymbol } from "#/lib/auth-client";\nexport const header = authClientSymbol;`,
    "apps/web/src/hooks/useAuth.ts": `import { utilsSymbol } from "#/lib/utils";\nexport const useAuth = utilsSymbol;`,
    "apps/web/src/routes/index.ts": `import { orpcClientSymbol } from "#/orpc/client";\nexport const route = orpcClientSymbol;`,
    "apps/web/src/routes/api.ts": `import { orpcClientSymbol } from "#/orpc/client";\nexport const api = orpcClientSymbol;`,
    ...extraConsumers,
  };
}

test("monorepo #/* alias: --relates from root finds all package importers (auth-client)", () => {
  const dir = makeRepo(makeMonorepoFixture());
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "apps/web/src/lib/auth-client.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pages\/login/, "missing login importer");
  assert.match(r.stdout, /pages\/settings/, "missing settings importer");
  assert.match(r.stdout, /components\/Header/, "missing Header importer");
  cleanup(dir);
});

test("monorepo #/* alias: --relates from root finds orpc client importers", () => {
  const dir = makeRepo(makeMonorepoFixture());
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "apps/web/src/orpc/client.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /routes\/index/, "missing routes/index importer");
  assert.match(r.stdout, /routes\/api/, "missing routes/api importer");
  cleanup(dir);
});

test("monorepo #/* alias: dynamic import() from #/ resolves at repo root", () => {
  const dir = makeRepo({
    ...makeMonorepoFixture(),
    "apps/web/src/lazy.ts": `export async function loadAuth() { return import("#/lib/auth-client"); }`,
  });
  gitInit(dir, { commit: true });
  const r = run(dir, "--relates", "apps/web/src/lib/auth-client.ts");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lazy/, "dynamic import() via #/ did not form dependency edge");
  cleanup(dir);
});
