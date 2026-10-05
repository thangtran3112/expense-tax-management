import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDirectory, "../../..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "expense-tax-generated-"));
const temporaryContractsRoot = path.join(tempRoot, "contracts-generated");
const temporaryPythonRoot = path.join(tempRoot, "python-generated");

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
  run("bash", [path.join(repoRoot, "packages/contracts/scripts/generate-python.sh")], {
    CONTRACTS_GENERATED_ROOT: temporaryContractsRoot,
    CONTRACTS_PYTHON_GENERATED_ROOT: temporaryPythonRoot,
  });

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
    [
      "common/python/expense-contracts/src/expense_contracts/generated/internal_messages.py",
      path.join(temporaryPythonRoot, "internal_messages.py"),
    ],
    [
      "common/python/expense-contracts/src/expense_contracts/generated/job_status_update_v1.py",
      path.join(temporaryPythonRoot, "job_status_update_v1.py"),
    ],
    [
      "common/python/expense-contracts/src/expense_contracts/generated/job_result_submit_v1.py",
      path.join(temporaryPythonRoot, "job_result_submit_v1.py"),
    ],
    [
      "common/python/expense-contracts/src/expense_contracts/generated/ocr_extraction_result_v1.py",
      path.join(temporaryPythonRoot, "ocr_extraction_result_v1.py"),
    ],
    [
      "common/python/expense-contracts/src/expense_contracts/generated/ocr_job_input_v1.py",
      path.join(temporaryPythonRoot, "ocr_job_input_v1.py"),
    ],
    [
      "common/python/expense-contracts/src/expense_contracts/generated/expense_enrichment_input_v1.py",
      path.join(temporaryPythonRoot, "expense_enrichment_input_v1.py"),
    ],
    [
      "common/python/expense-contracts/src/expense_contracts/generated/expense_enrichment_result_v1.py",
      path.join(temporaryPythonRoot, "expense_enrichment_result_v1.py"),
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
