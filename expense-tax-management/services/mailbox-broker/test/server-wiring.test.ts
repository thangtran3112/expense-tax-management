/**
 * Phase 3D-C Task 5 gap closure 2 — server.ts production wiring.
 *
 * `server.ts` executes real side effects at import time (connects to the
 * token vault, calls `app.listen`), the same shape every other server.ts
 * in this repo already has (app-api, foundry-service) -- none of them is
 * directly importable from a test. This is therefore a static wiring
 * check on the source text, same established convention as this
 * codebase's own `scripts/check-mailbox-t*-ci-wiring.test.mjs` family:
 * it fails if `materializeDependencies` is ever omitted from the
 * `buildApp` call, or built from anything other than the real
 * `appClient`/`providerAdapter` this file already constructs for every
 * other route. `buildMaterializeDependencies`'s own wiring logic (does it
 * actually delegate to the real objects, not silently drop them) is
 * covered directly, with real objects, by ingestion.test.ts's own
 * "buildMaterializeDependencies" suite -- this file only proves server.ts
 * calls it with the real things, never a fake/stub/omission.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/server.ts"),
  "utf8",
);

describe("server.ts — materialize production wiring", () => {
  it("imports buildMaterializeDependencies from ingestion.ts", () => {
    expect(serverSource).toMatch(/import\s*\{[^}]*buildMaterializeDependencies[^}]*\}\s*from\s*"\.\/ingestion\.js"/);
  });

  it("constructs materializeDependencies from the real appClient and providerAdapter, not a fake/stub", () => {
    const match = /const materializeDependencies\s*=\s*buildMaterializeDependencies\(([^)]*)\)/.exec(serverSource);
    expect(match, "server.ts must call buildMaterializeDependencies(...) to build materializeDependencies").not.toBeNull();
    const args = (match?.[1] ?? "").split(",").map((arg) => arg.trim());
    expect(args).toEqual(["appClient", "providerAdapter"]);
    // The same two identifiers server.ts already uses for every other
    // route (discoveryAppClient/discoveryProviderAdapter, appClient,
    // providerAdapter below) -- never a locally-declared fake/stub/mock.
    expect(serverSource).toMatch(/const appClient = createMailboxAppClient\(/);
    expect(serverSource).toMatch(/const providerAdapter = createGmailMailboxProvider\(/);
    expect(serverSource).not.toMatch(/\b(fake|stub|mock)[A-Za-z]*\s*(App[Cc]lient|[Pp]rovider[Aa]dapter)/);
  });

  it("passes materializeDependencies into the buildApp(...) call", () => {
    const buildAppCallMatch = /const app = buildApp\(\{([\s\S]*?)\n\}\);/.exec(serverSource);
    expect(buildAppCallMatch, "server.ts must call buildApp({...})").not.toBeNull();
    const buildAppArgs = buildAppCallMatch?.[1] ?? "";
    expect(buildAppArgs).toMatch(/^\s*materializeDependencies,?\s*$/m);
  });
});
