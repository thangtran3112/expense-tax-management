import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import YAML from "yaml";

const readPackage = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readRepo = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * Traces the chain from the CI workflow (read-only -- never edited here)
 * down to Phase 3D-A Task 6's real-PostgreSQL mailbox verification suite,
 * the same way check-dispatch-routing-ci-wiring.test.mjs traces Task 7
 * Stage A's PHASE_T7A_INTEGRATION wiring -- so a future refactor of
 * either end can't silently stop running it.
 */
test("the CI integration job runs the zero-skip phase chain (pnpm verify:phase-0n)", () => {
  const ci = YAML.parse(readRepo(".github/workflows/expense-tax-ci.yml"));
  const integrationSteps = ci.jobs.integration.steps.map((step) => step.run).filter(Boolean);
  assert.ok(
    integrationSteps.some((run) => /(^|\s)pnpm verify:phase-0n(\s|$)/.test(run)),
    "CI integration job must run `pnpm verify:phase-0n` (the terminal zero-skip verify script)",
  );
});

test("verify-phase-0n runs Phase 3D-A Task 6's mailbox domain verification suite with PHASE_3D_A_T6_INTEGRATION=1", () => {
  const verifyPhase0n = readPackage("scripts/verify-phase-0n.mjs");
  assert.match(
    verifyPhase0n,
    /test\/integration\/app-domain-3d-a-mailbox\.test\.ts/,
    "verify-phase-0n.mjs must invoke Task 6's mailbox verification suite directly",
  );
  assert.match(
    verifyPhase0n,
    /PHASE_3D_A_T6_INTEGRATION\s*:\s*"1"/,
    "verify-phase-0n.mjs must set PHASE_3D_A_T6_INTEGRATION=1 for that invocation",
  );
});
