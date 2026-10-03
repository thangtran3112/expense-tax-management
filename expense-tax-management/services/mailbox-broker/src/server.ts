import { buildApp } from "./app.js";
import { createMailboxAppClient } from "./app-client.js";
import { brokerConfigFromEnv } from "./config.js";
import { createVaultDatabase } from "./database/client.js";
import { createGmailMailboxProvider } from "./google-mailbox.js";

function requiredEnvironmentValue(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function requiredCommaListEnvironmentValue(key: string): readonly string[] {
  const items = requiredEnvironmentValue(key)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return items;
}

const configuredPort = Number(process.env.PORT ?? "8300");
const port = Number.isInteger(configuredPort) ? configuredPort : 8300;
const config = brokerConfigFromEnv({
  port,
  version: process.env.APP_VERSION ?? "0.1.0",
});

const database = createVaultDatabase(config.databaseUrl);

const appClient = createMailboxAppClient({
  baseUrl: config.outboundApp.baseUrl,
  issuerUrl: config.outboundApp.issuerUrl,
  jwksUrl: config.outboundApp.jwksUrl,
  credentials: config.outboundApp.credentials,
});

const providerAdapter = createGmailMailboxProvider({
  clientId: requiredEnvironmentValue("GOOGLE_OAUTH_CLIENT_ID"),
  clientSecret: requiredEnvironmentValue("GOOGLE_OAUTH_CLIENT_SECRET"),
  redirectUri: requiredEnvironmentValue("GOOGLE_OAUTH_REDIRECT_URI"),
  vaultKeys: config.vault,
  database,
  appClient,
});

const app = buildApp({
  config,
  appClient,
  providerAdapter,
  allowedRedirectOrigins: requiredCommaListEnvironmentValue("MAILBOX_ALLOWED_REDIRECT_ORIGINS"),
  ...(process.env.MAILBOX_CALLBACK_HOST?.trim()
    ? { expectedCallbackHost: process.env.MAILBOX_CALLBACK_HOST.trim() }
    : {}),
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.destroy();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error }, "shutdown failed");
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: config.port,
  });
} catch (error: unknown) {
  app.log.error({ err: error }, "server startup failed");
  await database.destroy();
  process.exitCode = 1;
}
