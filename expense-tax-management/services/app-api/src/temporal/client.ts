import { Client, Connection } from "@temporalio/client";
import type {
  JobReferenceV1,
  MailboxScanExecutionInputV1,
  WorkflowType,
} from "@expense-tax/contracts";

export interface StartWorkflowInput {
  readonly workflowType: WorkflowType;
  readonly workflowId: string;
  readonly taskQueue: string;
  /**
   * Temporal namespace to start this workflow in. Task 7 Stage A: the
   * dispatcher supplies the namespace stamped on the job row at creation
   * time (app.temporal_dispatch_routing), not a single config-wide default,
   * so old-generation jobs keep draining to their original namespace after
   * an operator `advance` cuts new jobs over. Falls back to the starter's
   * configured default namespace when omitted.
   */
  readonly namespace?: string;
  /**
   * Phase 3D-B Task 3: widened to also carry the opaque mailbox-scan
   * execution payload (`{schemaVersion, scanRunId}` only -- never fence/
   * provider fields). Still exactly one positional arg either way, same
   * as every existing workflow's `(jobReference)` signature.
   */
  readonly args: readonly [JobReferenceV1] | readonly [MailboxScanExecutionInputV1];
}

export interface StartWorkflowResult {
  readonly runId: string;
}

/**
 * Narrow, injectable interface over the Temporal TS client. App API only
 * ever *starts* workflows -- the workflow-worker service owns execution
 * (design doc section 4.3) -- so this deliberately does not expose the full
 * @temporalio/client surface. Tests inject a fake implementation instead of
 * needing a real Temporal server, the same DI convention `buildApp` already
 * uses for `database`/`authVerifiers`.
 */
export interface TemporalWorkflowStarter {
  start(input: StartWorkflowInput): Promise<StartWorkflowResult>;
  close(): Promise<void>;
}

export interface TemporalClientConfig {
  readonly address: string;
  readonly namespace: string;
}

export function createTemporalWorkflowStarter(
  config: TemporalClientConfig,
): TemporalWorkflowStarter {
  let connectionPromise: Promise<Connection> | undefined;
  // One Client per namespace, one shared Connection: Client is namespace-
  // bound at construction, Connection is not.
  const clientsByNamespace = new Map<string, Client>();

  async function connection(): Promise<Connection> {
    connectionPromise ??= Connection.connect({ address: config.address });
    return connectionPromise;
  }

  async function clientFor(namespace: string): Promise<Client> {
    let client = clientsByNamespace.get(namespace);
    if (!client) {
      client = new Client({ connection: await connection(), namespace });
      clientsByNamespace.set(namespace, client);
    }
    return client;
  }

  return {
    async start(input) {
      const client = await clientFor(input.namespace ?? config.namespace);
      const handle = await client.workflow.start(input.workflowType, {
        workflowId: input.workflowId,
        taskQueue: input.taskQueue,
        args: [...input.args],
        workflowIdConflictPolicy: "USE_EXISTING",
      });
      return { runId: handle.firstExecutionRunId };
    },
    async close() {
      if (connectionPromise) {
        await (await connectionPromise).close();
      }
    },
  };
}
