import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(root, "scripts", "compose.sh");
function run(label, command, args, env = process.env) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0 || result.error) {
    console.error(`FAIL ${label}`);
    process.exit(result.status ?? 1);
  }
  console.log(`PASS ${label}`);
}
run("Backend regression through 0P", "pnpm", ["verify:phase-0p"], {
  ...process.env,
  PHASE_0I_INTEGRATION: "1", PHASE_0J_INTEGRATION: "1",
  PHASE_0J_WAVE2_INTEGRATION: "1", PHASE_0J_WAVE3_INTEGRATION: "1",
  PHASE_0J_WAVE4_INTEGRATION: "1", PHASE_0J1_INTEGRATION: "1",
  PHASE_0K_WAVE_A_INTEGRATION: "1", PHASE_0K_WAVE_B_INTEGRATION: "1",
  PHASE_0L_INTEGRATION: "1",
  PHASE_0D_INTEGRATION: "1", PHASE_0C_INTEGRATION: "1",
  PHASE_0E_INTEGRATION: "1",
  PHASE_0P_INTEGRATION: "1",
});
for (const [label, script] of [
  ["Capture typecheck", "typecheck"],
  ["Capture lint", "lint"],
  ["Capture tests", "test"],
  ["Capture production build", "build"],
]) run(label, "pnpm", ["--filter", "@expense-tax/capture-web", script]);
run("Capture Docker build", compose, ["build", "capture-web"]);
run("Capture readiness", compose, ["up", "-d", "capture-web"]);
let ready = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  if (spawnSync("curl", ["--fail", "--silent", "http://127.0.0.1:7301/capture"]).status === 0) {
    ready = true;
    break;
  }
  spawnSync("sleep", ["1"]);
}
if (!ready) process.exit(1);
console.log("PASS Capture browser endpoint");
console.log("\nPASS Phase 0F aggregate verification: zero required checks skipped");
