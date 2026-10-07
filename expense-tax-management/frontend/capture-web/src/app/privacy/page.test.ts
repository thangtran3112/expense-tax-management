import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

/**
 * Web session wiring design (2026-10-06): the privacy page is static and
 * public, outside the `(capture)` auth gate (no Clerk hooks, no "use
 * client") -- the Google sign-in app needs to link to it as a privacy
 * URL that renders without signing in. This package has no React
 * rendering harness (@testing-library/react), so -- consistent with
 * ../../lib/clerk.test.ts's existing source-text assertions -- this
 * checks the page is public by construction and carries the required
 * disclosures, rather than mounting it.
 */
describe("privacy page", () => {
  it("renders with no Clerk auth gate (no hooks, no client boundary)", () => {
    expect(source).not.toContain("use client");
    expect(source).not.toContain("useAuth");
    expect(source).not.toContain("CaptureAuthGate");
    expect(source).not.toContain("@clerk/nextjs");
  });

  it("discloses the required privacy information", () => {
    expect(source).toContain("private family app");
    expect(source).toMatch(/stored on the family VPS/i);
    expect(source).toContain("Clerk");
    expect(source).toContain("Google");
    expect(source).toMatch(/not.*sold|never sold|nothing.*sold/i);
    expect(source).toContain("thangtran3112@gmail.com");
  });
});
