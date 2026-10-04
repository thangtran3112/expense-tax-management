import { fileURLToPath, pathToFileURL } from "node:url";

import { NativeConnection, Worker } from "@temporalio/worker";

import { createActivities, createMailboxActivities } from "./activities/index.js";
import {
  createMailboxMaterializeActivities,
  createMailboxOcrActivities,
} from "./activities/mailbox-ingestion.js";
import { createAppApiClient } from "./clients/app-api.js";
import { createFoundryClient } from "./clients/foundry.js";
import { createMailboxAppApiClient } from "./clients/mailbox-client.js";
import { workerConfigFromEnv, type WorkerConfig } from "./config.js";
import { extractFakeReceipt } from "./providers/fake-ocr.js";

export interface WorkerFactories {
  readonly connect: typeof NativeConnection.connect;
  readonly create: typeof Worker.create;
}

const defaultFactories: WorkerFactories = {
  connect: (options) => NativeConnection.connect(options),
  create: (options) => Worker.create(options),
};

export async function runWorker(
  config: WorkerConfig,
  factories: WorkerFactories = defaultFactories,
): Promise<void> {
  const connection = await factories.connect({
    address: config.temporal.address,
  });

  try {
    const appApi = createAppApiClient(config);
    const activities = createActivities({
      appApi,
      foundry: createFoundryClient(config),
      extractReceipt: extractFakeReceipt,
    });
    // Phase 3D-C Task 5: mailbox_ocr_receipt needs only the generic App
    // API identity (jobs:write/files:read) -- never mailbox credentials --
    // so it registers unconditionally, same as the generic `activities`
    // above.
    const mailboxOcrActivities = createMailboxOcrActivities({
      appApi,
      extractReceipt: extractFakeReceipt,
    });
    // Phase 3D-B Task 3: mirrors 3D-A Task 5's own "mailbox config is
    // optional, construct only when present" convention -- an ordinary
    // dev->main deploy carries no mailbox env at all.
    const mailboxClient =
      config.clerk.mailboxApp && config.clerk.mailboxBroker
        ? createMailboxAppApiClient(config)
        : undefined;
    const mailboxActivities = mailboxClient
      ? {
          ...createMailboxActivities({ mailboxClient }),
          ...createMailboxMaterializeActivities({ mailboxClient }),
        }
      : {};
    const worker = await factories.create({
      connection,
      namespace: config.temporal.namespace,
      taskQueue: config.temporal.taskQueue,
      workflowsPath: fileURLToPath(
        new URL("./workflows/index.js", import.meta.url),
      ),
      activities: { ...activities, ...mailboxOcrActivities, ...mailboxActivities },
      // Temporal Runtime handles SIGTERM and stops polling before this drain.
      shutdownGraceTime: "30s",
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

export async function startWorkerProcess(
  config?: WorkerConfig,
  factories: WorkerFactories = defaultFactories,
): Promise<void> {
  try {
    await runWorker(config ?? workerConfigFromEnv(), factories);
  } catch {
    console.error("workflow-worker failed to start or run");
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void startWorkerProcess();
}
