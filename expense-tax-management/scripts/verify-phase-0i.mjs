import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const gates = [
  {
    label: "Frozen pnpm install",
    command: "pnpm",
    args: ["install", "--frozen-lockfile"],
  },
  {
    label: "Contract runtime build",
    command: "pnpm",
    args: ["--filter", "@expense-tax/contracts", "build"],
  },
  {
    label: "TypeScript lint",
    command: "pnpm",
    args: ["lint"],
  },
  {
    label: "TypeScript type checks",
    command: "pnpm",
    args: ["typecheck"],
  },
  {
    label: "Generated contract drift",
    command: "pnpm",
    args: ["contracts:check"],
  },
  {
    label: "Essential TypeScript tests",
    command: "pnpm",
    args: ["test"],
  },
  {
    label: "Phase 0I builds",
    command: "pnpm",
    args: ["build"],
  },
  {
    label: "Credential boundary audit",
    command: "node",
    args: ["scripts/audit-credential-boundaries.mjs"],
  },
  {
    label: "Static Compose boundaries",
    command: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      "test/integration/compose-boundaries.test.ts",
    ],
  },
];

function runGate({ label, command, args, cwd = repoRoot }) {
  console.log(`\n=== ${label} ===`);

  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`FAIL ${label}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    const detail = result.signal
      ? `terminated by ${result.signal}`
      : `exited with status ${result.status}`;
    console.error(`FAIL ${label}: ${detail}`);
    process.exit(result.status ?? 1);
  }

  console.log(`PASS ${label}`);
}

for (const gate of gates) {
  runGate(gate);
}

if (process.env.PHASE_0I_INTEGRATION !== "1") {
  console.error("\nSKIP PostgreSQL integration boundaries: PHASE_0I_INTEGRATION is not 1");
  console.error(
    "FAIL Phase 0I completion: required PostgreSQL integration checks were skipped",
  );
  process.exit(1);
}

runGate({
  label: "PostgreSQL integration boundaries",
  command: "pnpm",
  args: [
    "exec",
    "vitest",
    "run",
    "test/integration/database-boundaries.test.ts",
  ],
});

console.log("\nPASS Phase 0I aggregate verification: zero required checks skipped");
