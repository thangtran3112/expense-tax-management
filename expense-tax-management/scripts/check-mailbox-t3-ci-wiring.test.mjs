import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import YAML from "yaml";

const readPackage = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readRepo = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * Phase 3D-B Task 3 fix round 1 (review finding 1 follow-through) --
 * traces the chain from the CI workflow down to Task 3's real-PostgreSQL
 * finalizeScanRun suite, same pattern as check-mailbox-t2-ci-wiring.test.mjs.
 */
test("the CI integration job runs the zero-skip phase chain (pnpm verify:phase-0n)", () => {
  const ci = YAML.parse(readRepo(".github/workflows/expense-tax-ci.yml"));
  const integrationSteps = ci.jobs.integration.steps.map((step) => step.run).filter(Boolean);
  assert.ok(
    integrationSteps.some((run) => /(^|\s)pnpm verify:phase-0n(\s|$)/.test(run)),
    "CI integration job must run `pnpm verify:phase-0n` (the terminal zero-skip verify script)",
  );
});

test("verify-phase-0n runs Phase 3D-B Task 3's mailbox finalize/lease-release suite with PHASE_3D_B_T3_INTEGRATION=1", () => {
  const verifyPhase0n = readPackage("scripts/verify-phase-0n.mjs");
  assert.match(
    verifyPhase0n,
    /test\/mailbox-finalize\.test\.ts/,
    "verify-phase-0n.mjs must invoke Task 3's mailbox-finalize.test.ts directly",
  );
  assert.match(
    verifyPhase0n,
    /PHASE_3D_B_T3_INTEGRATION\s*:\s*"1"/,
    "verify-phase-0n.mjs must set PHASE_3D_B_T3_INTEGRATION=1 for that invocation",
  );
});
