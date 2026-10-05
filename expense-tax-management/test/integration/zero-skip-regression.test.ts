/**
 * Zero-skip regression guard for Phase 3C integration tests.
 *
 * Wrapped in describe.skipIf(!phase3cEnabled) so it is skipped (and not
 * counted as pending/failed) when the generic pnpm test:integration command
 * runs without PHASE_3C_INTEGRATION=1.
 *
 * When the dedicated test:integration:3c command runs, PHASE_3C_INTEGRATION
 * is set to "1", the describe block executes, and the JSON inspection script
 * rejects any skipped/pending outcome as a second enforcement layer.
 */
import { describe, expect, it } from "vitest";

const phase3cEnabled = process.env.PHASE_3C_INTEGRATION === "1";

describe.skipIf(!phase3cEnabled)("Phase 3C zero-skip regression guard", () => {
  it("runs only through the required Phase 3C integration command", () => {
    expect(process.env.PHASE_3C_INTEGRATION).toBe("1");
  });
});
