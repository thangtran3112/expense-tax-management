import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import YAML from "yaml";

const readPackage = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readRepo = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * Traces the chain from the CI workflow (read-only -- never edited here) down
 * to the Task 7 Stage A real-PostgreSQL suite, so a future refactor of
 * either end can't silently stop running it. Review finding: the suite
 * exists but PHASE_T7A_INTEGRATION was never set anywhere CI reaches, so it
 * always skipped.
 */
test("the CI integration job runs the zero-skip phase chain (pnpm verify:phase-0n)", () => {
  const ci = YAML.parse(readRepo(".github/workflows/expense-tax-ci.yml"));
  const integrationSteps = ci.jobs.integration.steps.map((step) => step.run).filter(Boolean);
  assert.ok(
    integrationSteps.some((run) => /(^|\s)pnpm verify:phase-0n(\s|$)/.test(run)),
    "CI integration job must run `pnpm verify:phase-0n` (the terminal zero-skip verify script)",
  );
});

test("verify-phase-0n runs the Task 7 Stage A dispatch routing fence suite with PHASE_T7A_INTEGRATION=1", () => {
  const verifyPhase0n = readPackage("scripts/verify-phase-0n.mjs");
  assert.match(
    verifyPhase0n,
    /test\/integration\/app-domain-task7-dispatch-routing\.test\.ts/,
    "verify-phase-0n.mjs must invoke the Task 7 Stage A suite directly",
  );
  assert.match(
    verifyPhase0n,
    /PHASE_T7A_INTEGRATION\s*:\s*"1"/,
    "verify-phase-0n.mjs must set PHASE_T7A_INTEGRATION=1 for that invocation",
  );
});
