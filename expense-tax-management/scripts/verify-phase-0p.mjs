import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");

function run(label, command, args, env = process.env, cwd = repoRoot) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(`FAIL ${label}`);
    process.exit(result.status ?? 1);
  }
  console.log(`PASS ${label}`);
}

run(
  "0I→0E regression chain",
  "pnpm",
  ["verify:phase-0e"],
  {
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
    PHASE_0C_INTEGRATION: "1",
    PHASE_0E_INTEGRATION: "1",
  },
);
run("Contracts", "pnpm", ["--filter", "@expense-tax/contracts", "test"]);
run("App API", "pnpm", ["--filter", "@expense-tax/app-api", "test"]);

if (process.env.PHASE_0P_INTEGRATION !== "1") {
  console.error("SKIP Phase 0P integration: PHASE_0P_INTEGRATION must be 1");
  process.exit(1);
}
run("Local Postgres", composeScript, ["up", "-d", "postgres"]);
run("App migrations through 012", composeScript, ["run", "--rm", "--build", "app-api-migrate"]);
run(
  "Forwarded-intake trust matrix",
  "pnpm",
  ["exec", "vitest", "run", "test/integration/app-domain-0p-inbound.test.ts"],
  { ...process.env, PHASE_0P_INTEGRATION: "1" },
);
run("Generated drift", "pnpm", ["contracts:check"]);
run("App Docker build", composeScript, ["build", "app-api"]);
run("App readiness", composeScript, ["up", "-d", "app-api"]);

const ready = spawnSync(
  "curl",
  ["--fail", "--silent", "http://127.0.0.1:8100/health/ready"],
  { cwd: repoRoot, encoding: "utf8" },
);
if (ready.status !== 0) {
  console.error("FAIL App readiness probe");
  process.exit(1);
}
console.log("PASS App readiness probe");
console.log("\nPASS Phase 0P aggregate verification: zero required checks skipped");
