import { AI_WORKER_TASK_QUEUE } from "@expense-tax/contracts";
import { z } from "zod";

// Thrown by manual (non-Zod) config validation below. Carries the offending
// env var NAMES as structured data -- never values -- so a caller (worker.ts)
// can log them without parsing this error's message.
export class WorkerConfigError extends Error {
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[]) {
    super(message);
    this.name = "WorkerConfigError";
    this.variables = variables;
  }
}

export interface MachineCredentialConfig {
  readonly audience: string;
  readonly machineSecretKey: string;
  readonly subject: string;
}

export interface WorkerConfig {
  readonly temporal: {
    readonly address: string;
    readonly namespace: "expense-tax";
    readonly taskQueue: typeof AI_WORKER_TASK_QUEUE;
  };
  readonly services: {
    readonly appApiBaseUrl: string;
    readonly foundryBaseUrl: string;
    /**
     * Phase 3D-A Task 3: Compose-internal mailbox broker origin
     * (`http://mailbox-broker:8300`, hardcoded Compose literal per the
     * brief -- still parsed like any other base URL here).
     *
     * Phase 3D-A Task 5 (controller ruling): optional -- present only when
     * the operator's production Compose override wires the mailbox broker
     * (`MAILBOX_FEATURE_ENABLED=true`). An ordinary dev->main release's
     * base Compose carries no mailbox env at all, and nothing in this
     * worker's production startup (`worker.ts`) constructs
     * `createMailboxAppApiClient` yet (3D-B/C's job), so these fields are
     * unused today -- undefined is a safe, inert default.
     */
    readonly mailboxBrokerBaseUrl?: string;
  };
  readonly clerk: {
    readonly issuerUrl: string;
    readonly jwksUrl: string;
    readonly app: MachineCredentialConfig;
    readonly foundry: MachineCredentialConfig;
    /**
     * Phase 3D-A Task 3: the worker's mailbox-scoped credential calling
     * App API's mailbox routes (`mailbox:discover`/`mailbox:materialize`).
     * Audience is the existing `CLERK_APP_SERVICE_AUDIENCE` -- the same
     * App target `clerk.app` already calls -- but under a distinct
     * mailbox-scoped subject/secret, so a leaked mailbox credential cannot
     * reach non-mailbox App routes.
     *
     * Fix round 5: a DISTINCT Clerk machine from `mailboxBroker` below --
     * App API's service-token verifier accepts only a single audience, so
     * one machine per audience is required (`CLERK_MAILBOX_WORKER_APP_*`).
     */
    readonly mailboxApp?: MachineCredentialConfig;
    /**
     * Phase 3D-A Task 3: the worker's credential calling the mailbox
     * broker directly (3D-B/C), audience `CLERK_MAILBOX_SERVICE_AUDIENCE`.
     *
     * Fix round 5: a DISTINCT Clerk machine from `mailboxApp` above
     * (`CLERK_MAILBOX_WORKER_*`, no longer shared) -- this broker's own
     * verifier tolerates a multi-audience token, but App API's does not,
     * so the two machines must never be the same one.
     *
     * Optional for the same reason as `services.mailboxBrokerBaseUrl`
     * above (Task 5 controller ruling).
     */
    readonly mailboxBroker?: MachineCredentialConfig;
  };
  /**
   * Task 3 (real receipt OCR via OpenAI): zero to three OpenAI API keys,
   * trimmed, in CLERK_... env order, empty/whitespace-only entries
   * dropped. Never required -- an empty array just means the OpenAI
   * route is unavailable (createOpenAiReceiptExtractor throws
   * OpenAiNotConfigured) and the "fake" provider kind keeps working.
   */
  readonly openAiApiKeys: readonly string[];
}

const RequiredStringSchema = z.string().trim().min(1);
const PlaceholderPattern = /not[-_ ]?(?:configured|issued)|change.?me|placeholder/i;

function machineIdSchema(key: string): z.ZodType<string> {
  return RequiredStringSchema.regex(
    /^mch_[A-Za-z0-9]+$/,
    `${key} must be a Clerk machine ID`,
  );
}

function machineSecretSchema(key: string): z.ZodType<string> {
  return RequiredStringSchema.regex(
    /^ak_[A-Za-z0-9_-]+$/,
    `${key} must be a Clerk machine secret key`,
  ).refine(
    (value) => !PlaceholderPattern.test(value),
    `${key} must not be a placeholder`,
  );
}

const TemporalAddressSchema = RequiredStringSchema.refine((value) => {
  const match = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(
    value,
  );
  if (!match) {
    return false;
  }

  const port = Number(match[1]);
  return port >= 1 && port <= 65_535;
}, "TEMPORAL_HOST must be a host:port address");

function baseUrlSchema(key: string): z.ZodType<string> {
  return RequiredStringSchema.transform((value, context) => {
    try {
      const url = new URL(value);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error("unsafe base URL");
      }

      return url.origin;
    } catch {
      context.addIssue({
        code: "custom",
        message: `${key} must be an HTTP(S) origin without credentials`,
      });
      return z.NEVER;
    }
  });
}

function clerkUrlSchema(key: string): z.ZodType<string> {
  return RequiredStringSchema.transform((value, context) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("unsafe Clerk URL");
      }

      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      context.addIssue({
        code: "custom",
        message: `${key} must be an HTTPS URL without credentials`,
      });
      return z.NEVER;
    }
  });
}

const WorkerEnvironmentSchema = z.object({
  TEMPORAL_HOST: TemporalAddressSchema,
  TEMPORAL_NAMESPACE: z
    .string()
    .trim()
    .pipe(z.literal("expense-tax")),
  AI_WORKER_TASK_QUEUE: z
    .string()
    .trim()
    .pipe(z.literal(AI_WORKER_TASK_QUEUE)),
  APP_API_BASE_URL: baseUrlSchema("APP_API_BASE_URL"),
  FOUNDRY_BASE_URL: baseUrlSchema("FOUNDRY_BASE_URL"),
  MAILBOX_BROKER_BASE_URL: baseUrlSchema("MAILBOX_BROKER_BASE_URL").optional(),
  CLERK_ISSUER_URL: clerkUrlSchema("CLERK_ISSUER_URL"),
  CLERK_JWKS_URL: clerkUrlSchema("CLERK_JWKS_URL"),
  CLERK_APP_SERVICE_AUDIENCE: machineIdSchema(
    "CLERK_APP_SERVICE_AUDIENCE",
  ),
  CLERK_APP_MACHINE_SECRET_KEY: machineSecretSchema(
    "CLERK_APP_MACHINE_SECRET_KEY",
  ),
  CLERK_APP_SERVICE_SUBJECT: machineIdSchema("CLERK_APP_SERVICE_SUBJECT"),
  CLERK_FOUNDRY_SERVICE_AUDIENCE: machineIdSchema(
    "CLERK_FOUNDRY_SERVICE_AUDIENCE",
  ),
  CLERK_FOUNDRY_MACHINE_SECRET_KEY: machineSecretSchema(
    "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
  ),
  CLERK_FOUNDRY_SERVICE_SUBJECT: machineIdSchema(
    "CLERK_FOUNDRY_SERVICE_SUBJECT",
  ),
  CLERK_MAILBOX_SERVICE_AUDIENCE: machineIdSchema(
    "CLERK_MAILBOX_SERVICE_AUDIENCE",
  ).optional(),
  // Fix round 5: one Clerk machine per audience -- App API's service-token
  // verifier (services/app-api/src/auth/verifier.ts) deliberately accepts
  // only a single audience, so the worker cannot reuse its broker-scoped
  // machine (below) to call App API. This pair is the broker-audience
  // machine only.
  CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY: machineSecretSchema(
    "CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY",
  ).optional(),
  CLERK_MAILBOX_WORKER_SUBJECT: machineIdSchema(
    "CLERK_MAILBOX_WORKER_SUBJECT",
  ).optional(),
  // Fix round 5: the App-audience machine -- distinct Clerk machine ID
  // and secret from the broker-audience pair above, scoped to App API
  // only, so its tokens carry exactly one audience.
  CLERK_MAILBOX_WORKER_APP_MACHINE_SECRET_KEY: machineSecretSchema(
    "CLERK_MAILBOX_WORKER_APP_MACHINE_SECRET_KEY",
  ).optional(),
  CLERK_MAILBOX_WORKER_APP_SUBJECT: machineIdSchema(
    "CLERK_MAILBOX_WORKER_APP_SUBJECT",
  ).optional(),
  // Task 3 (real receipt OCR via OpenAI): optional on purpose -- never
  // required for config parsing to succeed, trimmed/filtered below.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_API_KEY_1: z.string().optional(),
  OPENAI_API_KEY_2: z.string().optional(),
});

/**
 * Phase 3D-A Task 5 (controller ruling): the four mailbox env vars above
 * are optional individually (so an ordinary dev->main release's base
 * Compose -- no mailbox env at all -- parses cleanly), but must be set
 * together or not at all: a partially-configured mailbox credential is a
 * deploy misconfiguration, not a valid "half enabled" state.
 */
const MAILBOX_WORKER_KEYS = [
  "MAILBOX_BROKER_BASE_URL",
  "CLERK_MAILBOX_SERVICE_AUDIENCE",
  "CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY",
  "CLERK_MAILBOX_WORKER_SUBJECT",
  "CLERK_MAILBOX_WORKER_APP_MACHINE_SECRET_KEY",
  "CLERK_MAILBOX_WORKER_APP_SUBJECT",
] as const;

export function workerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerConfig {
  const parsed = WorkerEnvironmentSchema.parse(env);

  const mailboxPresence = MAILBOX_WORKER_KEYS.map((key) => parsed[key] !== undefined);
  const mailboxPresentCount = mailboxPresence.filter(Boolean).length;
  if (mailboxPresentCount !== 0 && mailboxPresentCount !== MAILBOX_WORKER_KEYS.length) {
    const missing = MAILBOX_WORKER_KEYS.filter((_key, index) => !mailboxPresence[index]);
    throw new WorkerConfigError(
      `Mailbox worker configuration is incomplete: ${MAILBOX_WORKER_KEYS.join(", ")} must all be set together or all omitted`,
      missing,
    );
  }
  const mailboxConfigured = mailboxPresentCount === MAILBOX_WORKER_KEYS.length;

  const services: WorkerConfig["services"] = mailboxConfigured
    ? {
        appApiBaseUrl: parsed.APP_API_BASE_URL,
        foundryBaseUrl: parsed.FOUNDRY_BASE_URL,
        mailboxBrokerBaseUrl: parsed.MAILBOX_BROKER_BASE_URL as string,
      }
    : {
        appApiBaseUrl: parsed.APP_API_BASE_URL,
        foundryBaseUrl: parsed.FOUNDRY_BASE_URL,
      };

  const clerk: WorkerConfig["clerk"] = mailboxConfigured
    ? {
        issuerUrl: parsed.CLERK_ISSUER_URL,
        jwksUrl: parsed.CLERK_JWKS_URL,
        app: {
          audience: parsed.CLERK_APP_SERVICE_AUDIENCE,
          machineSecretKey: parsed.CLERK_APP_MACHINE_SECRET_KEY,
          subject: parsed.CLERK_APP_SERVICE_SUBJECT,
        },
        foundry: {
          audience: parsed.CLERK_FOUNDRY_SERVICE_AUDIENCE,
          machineSecretKey: parsed.CLERK_FOUNDRY_MACHINE_SECRET_KEY,
          subject: parsed.CLERK_FOUNDRY_SERVICE_SUBJECT,
        },
        // Fix round 5: distinct machines per audience -- mailboxApp uses
        // the App-audience pair, mailboxBroker keeps the broker-audience
        // pair. Never share a machine across the two.
        mailboxApp: {
          audience: parsed.CLERK_APP_SERVICE_AUDIENCE,
          machineSecretKey: parsed.CLERK_MAILBOX_WORKER_APP_MACHINE_SECRET_KEY as string,
          subject: parsed.CLERK_MAILBOX_WORKER_APP_SUBJECT as string,
        },
        mailboxBroker: {
          audience: parsed.CLERK_MAILBOX_SERVICE_AUDIENCE as string,
          machineSecretKey: parsed.CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY as string,
          subject: parsed.CLERK_MAILBOX_WORKER_SUBJECT as string,
        },
      }
    : {
        issuerUrl: parsed.CLERK_ISSUER_URL,
        jwksUrl: parsed.CLERK_JWKS_URL,
        app: {
          audience: parsed.CLERK_APP_SERVICE_AUDIENCE,
          machineSecretKey: parsed.CLERK_APP_MACHINE_SECRET_KEY,
          subject: parsed.CLERK_APP_SERVICE_SUBJECT,
        },
        foundry: {
          audience: parsed.CLERK_FOUNDRY_SERVICE_AUDIENCE,
          machineSecretKey: parsed.CLERK_FOUNDRY_MACHINE_SECRET_KEY,
          subject: parsed.CLERK_FOUNDRY_SERVICE_SUBJECT,
        },
      };

  const openAiApiKeys = [parsed.OPENAI_API_KEY, parsed.OPENAI_API_KEY_1, parsed.OPENAI_API_KEY_2]
    .map((key) => key?.trim() ?? "")
    .filter((key) => key.length > 0);

  return {
    temporal: {
      address: parsed.TEMPORAL_HOST,
      namespace: parsed.TEMPORAL_NAMESPACE,
      taskQueue: parsed.AI_WORKER_TASK_QUEUE,
    },
    services,
    clerk,
    openAiApiKeys,
  };
}
