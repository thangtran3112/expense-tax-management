import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");

function runGate({ label, command, args, env = process.env, cwd = repoRoot }) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
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

function waitForReady(label, url) {
  console.log(`\n=== ${label} ===`);
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const result = spawnSync(
      "curl",
      ["--fail", "--silent", "--show-error", url],
      { cwd: repoRoot, env: process.env, encoding: "utf8" },
    );
    if (result.status === 0) {
      process.stdout.write(`${result.stdout}\n`);
      console.log(`PASS ${label}`);
      return;
    }
    if (attempt < 30) spawnSync("sleep", ["1"], { cwd: repoRoot });
  }
  console.error(`FAIL ${label}: timed out after 30 attempts`);
  process.exit(1);
}

runGate({
  label: "Phase 0I/0J/0J1/0K/0L/0D regression verification",
  command: "pnpm",
  args: ["verify:phase-0d"],
  env: {
    ...process.env,
    PHASE_0I_INTEGRATION: "1",
    PHASE_0J_INTEGRATION: "1",
    PHASE_0J_WAVE2_INTEGRATION: "1",
    PHASE_0J_WAVE3_INTEGRATION: "1",
    PHASE_0J_WAVE4_INTEGRATION: "1",
    PHASE_0J1_INTEGRATION: "1",
    PHASE_0K_WAVE_A_INTEGRATION: "1",
    PHASE_0K_WAVE_B_INTEGRATION: "1",
    PHASE_0L_INTEGRATION: "1",
    PHASE_0D_INTEGRATION: "1",
  },
});

for (const gate of [
  {
    label: "Contracts tests (OCR schemas + generated artifacts)",
    command: "pnpm",
    args: ["--filter", "@expense-tax/contracts", "test"],
  },
  {
    label: "App API tests (OCR routes, extraction apply)",
    command: "pnpm",
    args: ["--filter", "@expense-tax/app-api", "test"],
  },
  {
    label: "Foundry tests (effective-route, quotas)",
    command: "pnpm",
    args: ["--filter", "@expense-tax/foundry-service", "test"],
  },
]) {
  runGate(gate);
}

let skippedRequiredGates = false;

if (process.env.PHASE_0C_INTEGRATION === "1") {
  runGate({
    label: "PostgreSQL + Temporal service startup",
    command: composeScript,
    args: ["up", "-d", "postgres", "temporal"],
  });
  runGate({
    label: "Phase 0C App API migrations (through 010)",
    command: composeScript,
    args: ["run", "--rm", "--build", "app-api-migrate"],
  });
  runGate({
    label: "Phase 0C Foundry migrations (through 004)",
    command: composeScript,
    args: ["run", "--rm", "--build", "foundry-service-migrate"],
  });
  runGate({
    label: "Phase 0C App OCR domain integration",
    command: "pnpm",
    args: ["exec", "vitest", "run", "test/integration/app-domain-0c-ocr.test.ts"],
    env: { ...process.env, PHASE_0C_INTEGRATION: "1" },
  });
  runGate({
    label: "Phase 0C Foundry effective-route integration",
    command: "pnpm",
    args: ["exec", "vitest", "run", "test/integration/foundry-domain-0c-routes.test.ts"],
    env: { ...process.env, PHASE_0C_INTEGRATION: "1" },
  });
} else {
  skippedRequiredGates = true;
  console.error("\nSKIP Phase 0C integration: PHASE_0C_INTEGRATION must be 1");
}

for (const gate of [
  {
    label: "Generated contract drift",
    command: "pnpm",
    args: ["contracts:check"],
  },
  {
    label: "App API Docker build",
    command: composeScript,
    args: ["build", "app-api"],
  },
  {
    label: "Foundry Docker build",
    command: composeScript,
    args: ["build", "foundry-service"],
  },
  {
    label: "App API local readiness",
    command: composeScript,
    args: ["up", "-d", "app-api"],
  },
  {
    label: "Foundry local readiness",
    command: composeScript,
    args: ["up", "-d", "foundry-service"],
  },
]) {
  runGate(gate);
}

waitForReady("App API readiness probe", "http://127.0.0.1:8100/health/ready");
waitForReady("Foundry readiness probe", "http://127.0.0.1:8200/health/ready");

if (skippedRequiredGates) {
  console.error("FAIL Phase 0C completion: required checks were skipped");
  process.exit(1);
}

console.log("\nPASS Phase 0C aggregate verification: zero required checks skipped");
