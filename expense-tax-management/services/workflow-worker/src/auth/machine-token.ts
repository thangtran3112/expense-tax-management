import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwksCache,
  jwtVerify,
  type FetchImplementation,
  type JWKSCacheInput,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

import type { MachineCredentialConfig } from "../config.js";

export type MachineTokenErrorCode =
  | "acquisition_failed"
  | "authentication_failed"
  | "invalid_token"
  | "timeout";

export class MachineTokenError extends Error {
  readonly code: MachineTokenErrorCode;

  constructor(code: MachineTokenErrorCode) {
    super(
      code === "authentication_failed"
        ? "Machine token credentials were rejected"
        : code === "invalid_token"
        ? "Machine token response was invalid"
        : code === "timeout"
          ? "Machine token acquisition timed out"
          : "Machine token acquisition failed",
    );
    this.name = "MachineTokenError";
    this.code = code;
  }
}

export type TokenProvider = () => Promise<string>;

export interface MachineTokenProviderConfig {
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  readonly credentials: MachineCredentialConfig;
  readonly scopes: readonly string[];
}

export interface MachineTokenProviderOptions {
  readonly endpoint?: string;
  readonly fetch?: typeof fetch;
  readonly nowSeconds?: () => number;
  readonly refreshSkewSeconds?: number;
  readonly timeoutMs?: number;
  readonly ttlSeconds?: number;
  readonly keyResolver?: JWTVerifyGetKey;
  readonly jwksFetch?: FetchImplementation;
}

const TokenResponseSchema = z.object({ token: z.string().min(1) });

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function discardResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  await withAbort(response.body.cancel(), signal).catch(() => undefined);
}

async function validateToken(
  token: string,
  config: MachineTokenProviderConfig,
  nowSeconds: number,
  keyResolver: JWTVerifyGetKey,
): Promise<number> {
  try {
    const { payload } = await jwtVerify(token, keyResolver, {
      algorithms: ["RS256"],
      audience: config.credentials.audience,
      currentDate: new Date(nowSeconds * 1_000),
      issuer: config.issuerUrl,
      requiredClaims: ["exp", "jti", "sub"],
      subject: config.credentials.subject,
    });
    if (payload.iss !== config.issuerUrl) {
      throw new Error("invalid issuer");
    }
    const hasExactAudience =
      payload.aud === config.credentials.audience ||
      (Array.isArray(payload.aud) &&
        payload.aud.length === 1 &&
        payload.aud[0] === config.credentials.audience);
    if (!hasExactAudience) {
      throw new Error("invalid audience");
    }
    if (payload.sub !== config.credentials.subject) {
      throw new Error("invalid subject");
    }

    const tokenScopes =
      typeof payload.scope === "string"
        ? payload.scope.split(/\s+/).filter(Boolean)
        : [];
    if (
      tokenScopes.length !== config.scopes.length ||
      config.scopes.some((scope) => !tokenScopes.includes(scope))
    ) {
      throw new Error("invalid scopes");
    }
    if (typeof payload.jti !== "string" || !payload.jti.trim()) {
      throw new Error("invalid token ID");
    }
    if (
      payload.nbf !== undefined &&
      (typeof payload.nbf !== "number" || payload.nbf > nowSeconds + 30)
    ) {
      throw new Error("invalid not-before");
    }
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
      throw new Error("invalid expiry");
    }

    return payload.exp;
  } catch (error) {
    if (error instanceof MachineTokenError) throw error;
    throw new MachineTokenError("invalid_token");
  }
}

export function createMachineTokenProvider(
  config: MachineTokenProviderConfig,
  options: MachineTokenProviderOptions = {},
): TokenProvider {
  const endpoint =
    options.endpoint ?? "https://api.clerk.com/v1/m2m_tokens";
  const fetchImplementation = options.fetch ?? fetch;
  const nowSeconds = options.nowSeconds ?? (() => Date.now() / 1_000);
  const refreshSkewSeconds = options.refreshSkewSeconds ?? 30;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const ttlSeconds = options.ttlSeconds ?? 300;
  const remoteJwksCache: JWKSCacheInput = {};
  let cachedToken: string | undefined;
  let expiresAt = 0;
  let issuance: Promise<string> | undefined;

  async function issue(): Promise<string> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.credentials.machineSecretKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          token_format: "jwt",
          seconds_until_expiration: ttlSeconds,
          claims: { scope: config.scopes.join(" ") },
        }),
        redirect: "error",
        signal,
      });
    } catch {
      throw new MachineTokenError(signal.aborted ? "timeout" : "acquisition_failed");
    }

    if (!response.ok) {
      await discardResponseBody(response, signal);
      throw new MachineTokenError(
        response.status === 401 || response.status === 403
          ? "authentication_failed"
          : "acquisition_failed",
      );
    }

    let token: string;
    try {
      const body = await withAbort(response.json(), signal);
      const parsed = TokenResponseSchema.parse(body);
      token = parsed.token;
    } catch {
      throw new MachineTokenError(signal.aborted ? "timeout" : "invalid_token");
    } finally {
      await discardResponseBody(response, signal);
    }

    const keyResolver =
      options.keyResolver ??
      createRemoteJWKSet(new URL(config.jwksUrl), {
        [customFetch]: async (url, init) =>
          (options.jwksFetch ?? fetch)(url, {
            ...init,
            signal: AbortSignal.any([signal, init.signal]),
          }),
        [jwksCache]: remoteJwksCache,
        timeoutDuration: timeoutMs,
      });
    const classifiedKeyResolver: JWTVerifyGetKey = async (...args) => {
      try {
        return await keyResolver(...args);
      } catch (error) {
        if (
          error instanceof errors.JWKSNoMatchingKey ||
          error instanceof errors.JWKSMultipleMatchingKeys
        ) {
          throw new MachineTokenError("invalid_token");
        }
        if (signal.aborted || error instanceof errors.JWKSTimeout) {
          throw new MachineTokenError("timeout");
        }
        throw new MachineTokenError("acquisition_failed");
      }
    };
    try {
      expiresAt = await withAbort(
        validateToken(token, config, nowSeconds(), classifiedKeyResolver),
        signal,
      );
    } catch (error) {
      if (error instanceof MachineTokenError) throw error;
      throw new MachineTokenError(signal.aborted ? "timeout" : "invalid_token");
    }
    cachedToken = token;
    return token;
  }

  return async () => {
    if (
      cachedToken !== undefined &&
      expiresAt - refreshSkewSeconds > nowSeconds()
    ) {
      return cachedToken;
    }

    issuance ??= issue().finally(() => {
      issuance = undefined;
    });
    return issuance;
  };
}
