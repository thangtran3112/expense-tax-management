import { buildApp } from "./app.js";
import { createAppConfig } from "./config.js";
import { createAppDatabase } from "./database/client.js";
import { createDatabaseClerkIdentityMappingDomain } from "./domain/clerk-identity.js";
import { createProcessingJobsDomain } from "./domain/processing-jobs.js";
import { createTemporalWorkflowStarter } from "./temporal/client.js";
import { startDispatchLoop } from "./temporal/dispatch-loop.js";

const configuredPort = Number(process.env.PORT ?? "8100");
const port = Number.isInteger(configuredPort) ? configuredPort : 8100;
const config = createAppConfig({
  port,
  version: process.env.APP_VERSION ?? "0.1.0",
});
const database = createAppDatabase(config.databaseUrl);
const temporalStarter = createTemporalWorkflowStarter(config.temporal);
const processingJobsDomain = createProcessingJobsDomain(database, temporalStarter);
const app = buildApp({
  config,
  database,
  clerkIdentityDomain: createDatabaseClerkIdentityMappingDomain(database),
  temporalStarter,
  processingJobsDomain,
});

let stopDispatchLoop: (() => void) | undefined;
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  stopDispatchLoop?.();
  await app.close();
  await temporalStarter.close();
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
  stopDispatchLoop = startDispatchLoop({
    dispatch: () => processingJobsDomain.dispatchPendingJobs({}),
    intervalMs: 2000,
    onError: (error) => {
      app.log.error({ err: error }, "job dispatch failed");
    },
  });
} catch (error: unknown) {
  app.log.error({ err: error }, "server startup failed");
  await temporalStarter.close();
  await database.destroy();
  process.exitCode = 1;
}
