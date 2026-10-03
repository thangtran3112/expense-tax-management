import { describe, expect, it } from "vitest";

import { parseFromGenerationFlag } from "../src/temporal/dispatch-routing.js";

describe("dispatch-routing CLI – parseFromGenerationFlag", () => {
  it("parses a positive integer --from-generation value", () => {
    expect(parseFromGenerationFlag(["--from-generation", "1"])).toBe(1);
    expect(parseFromGenerationFlag(["--from-generation", "42"])).toBe(42);
  });

  it("rejects a missing --from-generation flag", () => {
    expect(() => parseFromGenerationFlag([])).toThrow(/--from-generation/);
  });

  it("rejects a missing value", () => {
    expect(() => parseFromGenerationFlag(["--from-generation"])).toThrow(
      /--from-generation/,
    );
  });

  it("rejects a non-integer value", () => {
    expect(() => parseFromGenerationFlag(["--from-generation", "abc"])).toThrow(
      /positive integer/,
    );
    expect(() => parseFromGenerationFlag(["--from-generation", "1.5"])).toThrow(
      /positive integer/,
    );
  });

  it("rejects zero or negative values", () => {
    expect(() => parseFromGenerationFlag(["--from-generation", "0"])).toThrow(
      /positive integer/,
    );
    expect(() => parseFromGenerationFlag(["--from-generation", "-1"])).toThrow(
      /positive integer/,
    );
  });
});
