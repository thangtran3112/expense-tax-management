/**
 * Phase 3D-A Task 5 — deploy.sh behavior tests (fake docker on PATH),
 * mirroring the pattern in
 * test/integration/production-deployment-boundaries.test.ts's "Task 7
 * Stage B fix round 1" describe block (extract the real functions/arrays
 * from deploy.sh via regex, stitch them into a minimal script, run
 * against a fake docker). Proves the controller ruling end to end:
 * - mailbox-disabled: compose() invokes docker with the base Compose
 *   file only -- the mailbox override is never passed to `docker`.
 * - mailbox-enabled: compose() includes the override file,
 *   mailbox-broker-migrate runs before `up -d`, and mailbox-broker is
 *   included in the started/verified service set.
 * - rollback with a previous tag that predates the mailbox-broker image
 *   drops it gracefully (same optional-image treatment as
 *   workflow-worker), while workflow-worker itself stays mandatory.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const productionRoot = path.join(repoRoot, "deploy", "production");
const deployScript = readFileSync(path.join(productionRoot, "deploy.sh"), "utf8");

function extractFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?^\\}`, "mu"));
  if (!match) throw new Error(`could not extract function: ${name}`);
  return match[0];
}

function extractArray(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}=\\([^)]*\\)`, "mu"));
  if (!match) throw new Error(`could not extract array: ${name}`);
  return match[0];
}

const composeFn = extractFunction(deployScript, "compose");
const workflowWorkerImageExistsFn = extractFunction(deployScript, "workflow_worker_image_exists");
const mailboxBrokerImageExistsFn = extractFunction(deployScript, "mailbox_broker_image_exists");
const verifyRunningImagesFn = extractFunction(deployScript, "verify_running_images");
const rollbackFn = extractFunction(deployScript, "rollback");
const applicationServices = extractArray(deployScript, "APPLICATION_SERVICES");

/** Fake docker: logs every full invocation (one line per call) to $FAKE_DOCKER_LOG, then succeeds. */
const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_LOG:?}"
case "\$1" in
  image) exit 0 ;;
  manifest) exit 0 ;;
  compose)
    shift
    while [[ "\$1" != "pull" && "\$1" != "up" && "\$1" != "ps" && "\$1" != "rm" && "\$1" != "run" && "\$1" != "config" ]]; do shift; done
    sub="\$1"; shift
    case "\$sub" in
      ps)
        if [[ "\${1:-}" == "-q" ]]; then
          printf 'fake-container-%s\\n' "\$2"
        fi
        exit 0 ;;
      *) exit 0 ;;
    esac
    ;;
  inspect)
    container_id="\${*: -1}"
    svc="\${container_id#fake-container-}"
    printf 'ghcr.io/thangtran3112/family-app/expense-tax-%s:%s\\n' "\$svc" "\${IMAGE_TAG:-}"
    exit 0 ;;
  *) exit 0 ;;
esac
`;

function withFakeDocker<T>(run: (env: { bin: string; log: string; cleanup: () => void }) => T): T {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "expense-tax-mailbox-deploy-"));
  const bin = path.join(tempRoot, "bin");
  mkdirSync(bin, { recursive: true });
  const dockerPath = path.join(bin, "docker");
  writeFileSync(dockerPath, FAKE_DOCKER);
  chmodSync(dockerPath, 0o700);
  const log = path.join(tempRoot, "calls.log");
  writeFileSync(log, "");
  try {
    return run({ bin, log, cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runScript(script: string, extraEnv: Record<string, string> = {}): { status: number; stderr: string } {
  return withFakeDocker(({ bin, log }) => {
    const result = spawnSync("bash", ["-c", script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, ...extraEnv },
      encoding: "utf8",
    });
    return { status: result.status ?? 1, stderr: result.stderr ?? "" };
  });
}

function calls(log: string): string[] {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("deploy.sh compose() file selection (Phase 3D-A Task 5)", () => {
  it("passes only the base Compose file when MAILBOX_FEATURE_ENABLED is unset", () => {
    withFakeDocker(({ bin, log }) => {
      const script = `
set -Eeuo pipefail
PROJECT_NAME=expense-tax-production
COMPOSE_FILE="${path.join(productionRoot, "docker-compose.yml")}"
MAILBOX_COMPOSE_FILE="${path.join(productionRoot, "docker-compose.mailbox.yml")}"
COMPOSE_ENV_FILE=/dev/null
${composeFn}
compose pull app-api
`;
      const result = spawnSync("bash", ["-c", script], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const logged = calls(log);
      expect(logged.length).toBe(1);
      expect(logged[0]).toContain("-f");
      expect(logged[0]).toContain("docker-compose.yml");
      expect(logged[0]).not.toContain("docker-compose.mailbox.yml");
    });
  });

  it("adds the mailbox override file when MAILBOX_FEATURE_ENABLED=true", () => {
    withFakeDocker(({ bin, log }) => {
      const script = `
set -Eeuo pipefail
PROJECT_NAME=expense-tax-production
COMPOSE_FILE="${path.join(productionRoot, "docker-compose.yml")}"
MAILBOX_COMPOSE_FILE="${path.join(productionRoot, "docker-compose.mailbox.yml")}"
COMPOSE_ENV_FILE=/dev/null
MAILBOX_FEATURE_ENABLED=true
${composeFn}
compose pull app-api
`;
      const result = spawnSync("bash", ["-c", script], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const logged = calls(log);
      expect(logged.length).toBe(1);
      expect(logged[0]).toContain("docker-compose.yml");
      expect(logged[0]).toContain("docker-compose.mailbox.yml");
    });
  });
});

describe("deploy.sh mailbox-broker migrate step (Phase 3D-A Task 5)", () => {
  function migrateScript(mailboxEnabled: boolean): string {
    return `
set -Eeuo pipefail
PROJECT_NAME=expense-tax-production
COMPOSE_FILE="${path.join(productionRoot, "docker-compose.yml")}"
MAILBOX_COMPOSE_FILE="${path.join(productionRoot, "docker-compose.mailbox.yml")}"
COMPOSE_ENV_FILE=/dev/null
MAILBOX_FEATURE_ENABLED=${mailboxEnabled ? "true" : "false"}
${composeFn}
compose run --rm app-api-migrate
compose run --rm foundry-service-migrate
if [[ "\${MAILBOX_FEATURE_ENABLED:-false}" == "true" ]]; then
  compose run --rm mailbox-broker-migrate
fi
compose up -d app-api foundry-service${mailboxEnabled ? " mailbox-broker" : ""}
`;
  }

  it("skips mailbox-broker-migrate and never starts mailbox-broker when disabled", () => {
    const { status, stderr } = runScript(migrateScript(false));
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("runs mailbox-broker-migrate before starting mailbox-broker when enabled", () => {
    withFakeDocker(({ bin, log }) => {
      const result = spawnSync("bash", ["-c", migrateScript(true)], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const logged = calls(log);
      const migrateIndex = logged.findIndex((line) => line.includes("mailbox-broker-migrate"));
      const upIndex = logged.findIndex((line) => line.includes("up -d") || line.includes(" up "));
      expect(migrateIndex).toBeGreaterThanOrEqual(0);
      expect(upIndex).toBeGreaterThan(migrateIndex);
      expect(logged[upIndex]).toContain("mailbox-broker");
    });
  });
});

describe("deploy.sh rollback: mailbox-broker is optional like workflow-worker (Phase 3D-A Task 5)", () => {
  function runRollback(options: { readonly mailboxBrokerImageExists: boolean }): {
    readonly stderr: string;
    readonly pulled: string[];
    readonly removed: string[];
  } {
    return withFakeDocker(({ bin, log }) => {
      const tempRoot = path.dirname(log);
      const stateDir = path.join(tempRoot, "state");
      mkdirSync(stateDir, { recursive: true });
      const pullLog = path.join(stateDir, "pull-args");
      const rmLog = path.join(stateDir, "rm-args");

      // Extend the shared fake docker's compose dispatch with pull/rm
      // arg recording (same technique as the Task 7 Stage B harness),
      // specific to this rollback scenario.
      const dockerPath = path.join(bin, "docker");
      writeFileSync(
        dockerPath,
        `#!/usr/bin/env bash
set -euo pipefail
case "\$1" in
  image)
    case "\$3" in
      *expense-tax-mailbox-broker:*) [[ "\${MAILBOX_BROKER_IMAGE_EXISTS:-0}" == "1" ]] && exit 0 || exit 1 ;;
      *) exit 0 ;;
    esac ;;
  manifest)
    case "\$3" in
      *expense-tax-mailbox-broker:*) [[ "\${MAILBOX_BROKER_IMAGE_EXISTS:-0}" == "1" ]] && exit 0 || exit 1 ;;
      *) exit 0 ;;
    esac ;;
  compose)
    shift
    while [[ "\$1" != "pull" && "\$1" != "up" && "\$1" != "ps" && "\$1" != "rm" ]]; do shift; done
    sub="\$1"; shift
    case "\$sub" in
      pull) printf '%s\\n' "\$@" >> "${pullLog}"; exit 0 ;;
      up) exit 0 ;;
      ps)
        if [[ "\${1:-}" == "-q" ]]; then
          printf 'fake-container-%s\\n' "\$2"
        else
          printf '%s\\n' app-api foundry-service workflow-worker mailbox-broker capture-web office-web foundry-web
        fi
        exit 0 ;;
      rm) printf '%s\\n' "\${*: -1}" >> "${rmLog}"; exit 0 ;;
    esac ;;
  inspect)
    container_id="\${*: -1}"
    svc="\${container_id#fake-container-}"
    printf 'ghcr.io/thangtran3112/family-app/expense-tax-%s:%s\\n' "\$svc" "\${IMAGE_TAG:-}"
    exit 0 ;;
  exec) exit 0 ;;
  *) exit 0 ;;
esac
`,
      );
      chmodSync(dockerPath, 0o700);
      const fakeCurl = path.join(bin, "curl");
      writeFileSync(fakeCurl, "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(fakeCurl, 0o700);

      const script = `
set -Eeuo pipefail
PROJECT_NAME=expense-tax-production
SCRIPT_DIR="${productionRoot}"
COMPOSE_FILE="${path.join(productionRoot, "docker-compose.yml")}"
MAILBOX_COMPOSE_FILE="${path.join(productionRoot, "docker-compose.mailbox.yml")}"
COMPOSE_ENV_FILE=/dev/null
INCOMING_ENV_FILE=/dev/null
TARGET_ENV_FILE=/dev/null
had_target=0
env_backup=/dev/null
previous_tag="0000000000000000000000000000000000000000"
MAILBOX_FEATURE_ENABLED=true
${applicationServices}
APPLICATION_SERVICES+=(mailbox-broker)
${composeFn}
${workflowWorkerImageExistsFn}
${mailboxBrokerImageExistsFn}
${verifyRunningImagesFn}
${rollbackFn}
rollback 1
`;
      const env: Record<string, string> = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        WORKFLOW_WORKER_PROBE_ATTEMPTS: "1",
        WORKFLOW_WORKER_PROBE_DELAY_SECONDS: "0",
        HEALTH_CHECK_ATTEMPTS: "1",
        HEALTH_CHECK_DELAY_SECONDS: "0",
        MAILBOX_BROKER_IMAGE_EXISTS: options.mailboxBrokerImageExists ? "1" : "0",
      };
      const result = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      const read = (file: string) => {
        try {
          return readFileSync(file, "utf8").split("\n").filter(Boolean);
        } catch {
          return [];
        }
      };
      return { stderr: result.stderr ?? "", pulled: read(pullLog), removed: read(rmLog) };
    });
  }

  it("drops mailbox-broker from rollback when the previous tag predates its image, keeping workflow-worker mandatory", () => {
    const { stderr, pulled, removed } = runRollback({ mailboxBrokerImageExists: false });

    expect(stderr).toContain("mailbox-broker has no image for tag");
    expect(stderr).toContain("rollback verified at prior image tag");
    expect(stderr).not.toContain("rollback failed");
    expect(pulled).not.toContain("mailbox-broker");
    expect(pulled).toContain("workflow-worker");
    expect(removed).toContain("mailbox-broker");
    expect(removed).not.toContain("workflow-worker");
  });

  it("keeps mailbox-broker in rollback when the previous tag's image exists", () => {
    const { stderr, pulled, removed } = runRollback({ mailboxBrokerImageExists: true });

    expect(stderr).toContain("rollback verified at prior image tag");
    expect(stderr).not.toContain("rollback failed");
    expect(pulled).toContain("mailbox-broker");
    expect(removed).not.toContain("mailbox-broker");
  });
});
