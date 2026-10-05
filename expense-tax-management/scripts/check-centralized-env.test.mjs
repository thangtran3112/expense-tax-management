import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Guards the family-config rule: env comes from Firestore through
// common/config/family_config.py, never from repository env or key files.
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(appRoot, "..");
const read = (path) => readFileSync(join(appRoot, path), "utf8");
const RUN_LOCAL = "../common/config/family_config.py run expense-tax-management/local --";
const THIS_FILE = "scripts/check-centralized-env.test.mjs";

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist" || entry === ".venv" || entry === "__pycache__") return [];
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test("compose.sh never reads the gitignored .env", () => {
  const compose = read("scripts/compose.sh");
  assert.match(compose, /EXPENSE_TAX_ENV_FILE:-\$PROJECT_DIR\/\.env\.example/);
  assert.doesNotMatch(compose, /\/\.env["}]/);
});

test("local developer scripts load env from family config", () => {
  const { scripts } = JSON.parse(read("package.json"));
  for (const name of [
    "compose:up",
    "compose:down",
    "dev:app-api",
    "dev:foundry",
    "db:migrate:app",
    "db:migrate:foundry",
    "smoke:local-worker",
  ]) {
    assert.ok(scripts[name].startsWith(`${RUN_LOCAL} `), `${name} must run under ${RUN_LOCAL}`);
  }
  assert.equal(scripts["with-env"], RUN_LOCAL);
  assert.ok(scripts["ci:test"].includes("pnpm check:centralized-env"));
  assert.ok(scripts["ci:test"].includes("python3 -m unittest discover -s ../common/config -p 'test_*.py'"));
});

test("no code path reads repository key files", () => {
  const roots = [
    "scripts",
    "deploy",
    "infrastructure/gcp/expense-tax",
    ...readdirSync(join(appRoot, "services")).map((service) => `services/${service}/src`),
  ];
  const offenders = roots
    .flatMap((root) => filesUnder(join(appRoot, root)))
    .filter((path) => relative(appRoot, path) !== THIS_FILE)
    .filter((path) => /\.keys\/|postgres-vps\.env/.test(readFileSync(path, "utf8")))
    .map((path) => relative(appRoot, path));
  assert.deepEqual(offenders, []);
});

test("AGENTS.md records the Env and Secrets rule", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /^## Env and Secrets$/m);
  assert.match(agents, /Firestore `family-config`/);
  assert.match(agents, /common\/config\/family_config\.py/);
});

test("expense CI runs when family config changes", () => {
  const ci = readFileSync(join(repoRoot, ".github/workflows/expense-tax-ci.yml"), "utf8");
  assert.match(ci, /- "common\/config\/\*\*"/);
});
