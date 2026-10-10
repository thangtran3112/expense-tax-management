import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FILE_NAME, renderJsonSchema } from "../scripts/generate-json-schema.ts";
import { StrategySpecV1Schema } from "../src/strategy-spec-v1.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function jsonFiles(directory: string): [string, unknown][] {
  const full = path.join(root, directory);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(path.join(full, name), "utf8"))]);
}

const valid = jsonFiles("fixtures/strategy-spec-v1/valid");
const invalid = jsonFiles("fixtures/strategy-spec-v1/invalid");
const templates = jsonFiles("templates");

test("fixture folders are not empty", () => {
  assert.ok(valid.length >= 3 && invalid.length >= 20);
});

for (const [name, spec] of [...valid, ...templates]) {
  test(`accepts ${name}`, () => {
    const result = StrategySpecV1Schema.safeParse(spec);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
}

for (const [name, spec] of invalid) {
  test(`rejects ${name}`, () => {
    assert.equal(StrategySpecV1Schema.safeParse(spec).success, false);
  });
}

test("generated JSON Schema is current (run pnpm generate:json-schema)", () => {
  const checkedIn = readFileSync(path.join(root, "generated", FILE_NAME), "utf8");
  assert.equal(checkedIn, renderJsonSchema());
});
