import { describe, expect, it, vi } from "vitest";

import { workerConfigFromEnv } from "../src/config.js";
import {
  runWorker,
  startWorkerProcess,
  type WorkerFactories,
} from "../src/worker.js";

const config = workerConfigFromEnv({
  TEMPORAL_HOST: "temporal:7233",
  TEMPORAL_NAMESPACE: "expense-tax",
  AI_WORKER_TASK_QUEUE: "expense-tax-processing",
  APP_API_BASE_URL: "http://app-api:8100",
  FOUNDRY_BASE_URL: "http://foundry-service:8200",
  MAILBOX_BROKER_BASE_URL: "http://mailbox-broker:8300",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_APP_SERVICE_AUDIENCE: "mch_appAudience",
  CLERK_APP_MACHINE_SECRET_KEY: "ak_test_app_secret",
  CLERK_APP_SERVICE_SUBJECT: "mch_app",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "mch_foundryAudience",
  CLERK_FOUNDRY_MACHINE_SECRET_KEY: "ak_test_foundry_secret",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "mch_foundry",
  CLERK_MAILBOX_SERVICE_AUDIENCE: "mch_mailboxAudience",
  CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY: "ak_test_mailbox_secret",
  CLERK_MAILBOX_WORKER_SUBJECT: "mch_workerMailbox",
});

function workerFactories(options: { runError?: Error } = {}) {
  const close = vi.fn().mockResolvedValue(undefined);
  const run = options.runError
    ? vi.fn().mockRejectedValue(options.runError)
    : vi.fn().mockResolvedValue(undefined);
  const connection = { close };
  const worker = { run };
  const connect = vi.fn().mockResolvedValue(connection);
  const create = vi.fn().mockResolvedValue(worker);

  return {
    close,
    connect,
    connection,
    create,
    factories: { connect, create } as unknown as WorkerFactories,
    run,
  };
}

describe("workflow worker process", () => {
  it("creates one connection and runs the canonical worker", async () => {
    const fakes = workerFactories();

    await runWorker(config, fakes.factories);

    expect(fakes.connect).toHaveBeenCalledOnce();
    expect(fakes.connect).toHaveBeenCalledWith({ address: "temporal:7233" });
    expect(fakes.create).toHaveBeenCalledWith({
      connection: fakes.connection,
      namespace: "expense-tax",
      taskQueue: "expense-tax-processing",
      workflowsPath: expect.stringMatching(/workflows\/index\.js$/),
      activities: expect.objectContaining({
        mark_running: expect.any(Function),
        submit_echo_result: expect.any(Function),
      }),
      shutdownGraceTime: "30s",
    });
    expect(fakes.run).toHaveBeenCalledOnce();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("closes the connection when the worker fails", async () => {
    const failure = new Error("worker failed");
    const fakes = workerFactories({ runError: failure });

    await expect(runWorker(config, fakes.factories)).rejects.toBe(failure);
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("sets a nonzero exit code without printing startup error details", async () => {
    const previousExitCode = process.exitCode;
    const error = new Error("secret-value");
    const connect = vi.fn().mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      process.exitCode = undefined;
      await startWorkerProcess(config, {
        connect,
        create: vi.fn(),
      } as unknown as WorkerFactories);

      expect(process.exitCode).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        "workflow-worker failed to start or run",
      );
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("secret-value"),
      );
    } finally {
      process.exitCode = previousExitCode;
      consoleError.mockRestore();
    }
  });
});
