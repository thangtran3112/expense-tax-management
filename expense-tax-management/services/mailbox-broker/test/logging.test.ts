import { describe, expect, it } from "vitest";

import { containsBearerToken, redact, SENSITIVE_LOG_PATHS } from "../src/logging.js";

describe("logging redaction", () => {
  it("redacts token/key/authorization fields at any depth", () => {
    const input = {
      accessToken: "ya29.abc123",
      refreshToken: "1//abc",
      nonce: "deadbeef",
      ciphertext: "base64bytes",
      authTag: "tagbytes",
      headers: { authorization: "Bearer abc.def.ghi" },
      nested: { secretKey: "k1", ok: "fine" },
    };

    const result = redact(input) as Record<string, unknown>;

    expect(result.accessToken).toBe("[Redacted]");
    expect(result.refreshToken).toBe("[Redacted]");
    expect(result.nonce).toBe("[Redacted]");
    expect(result.ciphertext).toBe("[Redacted]");
    expect(result.authTag).toBe("[Redacted]");
    expect((result.headers as Record<string, unknown>).authorization).toBe(
      "[Redacted]",
    );
    expect((result.nested as Record<string, unknown>).secretKey).toBe(
      "[Redacted]",
    );
    expect((result.nested as Record<string, unknown>).ok).toBe("fine");
  });

  it("leaves non-sensitive fields untouched", () => {
    const result = redact({ connectionId: "abc", status: "active" }) as Record<
      string,
      unknown
    >;
    expect(result.connectionId).toBe("abc");
    expect(result.status).toBe("active");
  });

  it("includes authorization-header paths in the Fastify-style redact list", () => {
    expect(SENSITIVE_LOG_PATHS).toContain("headers.authorization");
    expect(SENSITIVE_LOG_PATHS).toContain("req.headers.authorization");
    expect(SENSITIVE_LOG_PATHS).toContain("request.headers.authorization");
  });

  it("detects a raw bearer token so a test can assert one never appears in a log line", () => {
    expect(containsBearerToken("authorization: Bearer abc.def.ghi-123")).toBe(true);
    expect(containsBearerToken("authorization: [Redacted]")).toBe(false);
  });
});
