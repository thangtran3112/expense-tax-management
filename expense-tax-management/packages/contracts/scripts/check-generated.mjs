import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDirectory, "../../..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "expense-tax-generated-"));
const temporaryContractsRoot = path.join(tempRoot, "contracts-generated");

function run(command, args, environment = {}) {
  execFileSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
}

try {
  run("pnpm", ["--filter", "@expense-tax/contracts", "run", "generate:json-schema"], {
    CONTRACTS_GENERATED_ROOT: temporaryContractsRoot,
  });
  run("pnpm", ["--filter", "@expense-tax/gateway-policy", "run", "build"]);
  run("pnpm", ["--filter", "@expense-tax/app-api", "run", "generate:openapi"], {
    OPENAPI_OUTPUT_PATH: path.join(
      temporaryContractsRoot,
      "openapi",
      "app-api.openapi.json",
    ),
  });
  run("pnpm", ["--filter", "@expense-tax/foundry-service", "run", "generate:openapi"], {
    OPENAPI_OUTPUT_PATH: path.join(
      temporaryContractsRoot,
      "openapi",
      "foundry-service.openapi.json",
    ),
  });
  run(
    "pnpm",
    ["--filter", "@expense-tax/contracts", "run", "generate:typescript-clients"],
    { CONTRACTS_GENERATED_ROOT: temporaryContractsRoot },
  );

  const comparisons = [
    [
      "packages/contracts/generated/json-schema/internal-messages.schema.json",
      path.join(temporaryContractsRoot, "json-schema", "internal-messages.schema.json"),
    ],
    [
      "packages/contracts/generated/json-schema/job-status-update-v1.schema.json",
      path.join(temporaryContractsRoot, "json-schema", "job-status-update-v1.schema.json"),
    ],
    [
      "packages/contracts/generated/json-schema/job-result-submit-v1.schema.json",
      path.join(temporaryContractsRoot, "json-schema", "job-result-submit-v1.schema.json"),
    ],
    [
      "packages/contracts/generated/json-schema/ocr-extraction-result-v1.schema.json",
      path.join(temporaryContractsRoot, "json-schema", "ocr-extraction-result-v1.schema.json"),
    ],
    [
      "packages/contracts/generated/json-schema/ocr-job-input-v1.schema.json",
      path.join(temporaryContractsRoot, "json-schema", "ocr-job-input-v1.schema.json"),
    ],
    [
      "packages/contracts/generated/json-schema/expense-enrichment-input-v1.schema.json",
      path.join(temporaryContractsRoot, "json-schema", "expense-enrichment-input-v1.schema.json"),
    ],
    [
      "packages/contracts/generated/json-schema/expense-enrichment-result-v1.schema.json",
      path.join(temporaryContractsRoot, "json-schema", "expense-enrichment-result-v1.schema.json"),
    ],
    [
      "packages/contracts/generated/openapi/app-api.openapi.json",
      path.join(temporaryContractsRoot, "openapi", "app-api.openapi.json"),
    ],
    [
      "packages/contracts/generated/openapi/foundry-service.openapi.json",
      path.join(temporaryContractsRoot, "openapi", "foundry-service.openapi.json"),
    ],
    [
      "packages/contracts/generated/typescript/app-api.paths.ts",
      path.join(temporaryContractsRoot, "typescript", "app-api.paths.ts"),
    ],
    [
      "packages/contracts/generated/typescript/foundry-service.paths.ts",
      path.join(temporaryContractsRoot, "typescript", "foundry-service.paths.ts"),
    ],
  ];

  const mismatches = [];
  for (const [checkedInPath, generatedPath] of comparisons) {
    const checkedIn = await readFile(path.join(repoRoot, checkedInPath));
    const generated = await readFile(generatedPath);
    if (!checkedIn.equals(generated)) {
      mismatches.push(checkedInPath);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`Generated artifacts are out of date:\n${mismatches.join("\n")}`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
