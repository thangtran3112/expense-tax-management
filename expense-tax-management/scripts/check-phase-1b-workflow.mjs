import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const appRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const workflowPath = join(appRoot, "../.github/workflows/expense-tax-deploy.yml");
const raw = readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(raw);
const failures = [];

function assertIncludes(source, expected, label = expected) {
  if (!source.includes(expected)) failures.push(`missing: ${label}`);
}

function assertExcludes(source, forbidden, label = forbidden) {
  if (source.includes(forbidden)) failures.push(`forbidden: ${label}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) failures.push(`expected ${label} to equal ${expected}, got ${actual}`);
}

const trigger = workflow.on ?? workflow["on"];
assertEqual(trigger?.workflow_run?.workflows?.[0], "Expense Tax CI", "workflow_run workflow name");
assertEqual(trigger?.workflow_run?.types?.[0], "completed", "workflow_run event type");
assertIncludes(raw, "github.event.workflow_run.conclusion == 'success'");
assertIncludes(raw, "github.event.workflow_run.head_branch == 'main'");
assertIncludes(raw, "github.event.workflow_run.head_repository.full_name == github.repository");
assertExcludes(raw, "pull_request", "pull-request deployment path");

assertIncludes(raw, "actions/checkout@v7");
assertIncludes(raw, "ref: ${{ github.event.workflow_run.head_sha }}");
assertIncludes(raw, "persist-credentials: false");
assertIncludes(raw, "docker/setup-buildx-action@v3");
assertIncludes(raw, "docker/login-action@v3");
assertIncludes(raw, "docker/build-push-action@v6");
assertIncludes(raw, "environment: production", "production build environment");
assertIncludes(
  raw,
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${{ vars.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}",
  "public Clerk publishable key build argument",
);
assertExcludes(raw, "CLERK_SECRET_KEY", "server Clerk secret in image build");
assertIncludes(raw, "packages: write");
assertIncludes(raw, "contents: read");
assertIncludes(raw, "GITHUB_TOKEN");
assertIncludes(raw, "type=gha,scope=");

const imageNames = [
  "expense-tax-app-api",
  "expense-tax-foundry-service",
  "expense-tax-ai-worker",
  "expense-tax-workflow-worker",
  "expense-tax-mailbox-broker",
  "expense-tax-capture-web",
  "expense-tax-office-web",
  "expense-tax-foundry-web",
];
const matrixImages = workflow.jobs?.build?.strategy?.matrix?.include ?? [];
assertEqual(matrixImages.length, 8, "build image matrix size");
assertEqual(
  matrixImages.map(({ image }) => image).sort().join(","),
  imageNames.slice().sort().join(","),
  "build image matrix names",
);
for (const image of imageNames) assertIncludes(raw, image, `image ${image}`);
assertIncludes(raw, "github.event.workflow_run.head_sha");
assertExcludes(raw, ":latest", "mutable latest image tag");

assertIncludes(raw, "environment: production");
assertIncludes(raw, "concurrency:");
assertIncludes(raw, "needs: build");
// Production env comes from Firestore family-config on the VPS, never from CI.
assertExcludes(raw, "id-token: write", "CI-side GCP identity");
assertExcludes(raw, "google-github-actions/auth", "CI-side GCP authentication");
assertExcludes(raw, "gcloud secrets", "CI-side secret fetch");
assertIncludes(raw, "common/config/family_config.py");
assertIncludes(
  raw,
  "FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json /opt/expense-tax-management/app/family_config.py run expense-tax-management/production --env-file-var DEPLOY_ENV_FILE -- /opt/expense-tax-management/app/deploy.sh",
);
assertIncludes(raw, "VPS_DEPLOY_SSH_KEY");
assertIncludes(raw, "VPS_DEPLOY_KNOWN_HOSTS");
assertExcludes(raw, "ssh-keyscan", "runtime host-key discovery");
assertIncludes(raw, "StrictHostKeyChecking=yes");
assertIncludes(raw, "scp");
assertIncludes(
  raw,
  'SCP_OPTIONS=(-i "$SSH_KEY_FILE" -o UserKnownHostsFile="$KNOWN_HOSTS_FILE" -o StrictHostKeyChecking=yes -P "$VPS_PORT")',
  "scp uses uppercase port option",
);
assertIncludes(raw, 'scp "${SCP_OPTIONS[@]}"');
assertExcludes(raw, 'scp "${SSH_OPTIONS[@]}"', "scp reusing ssh options");
assertIncludes(raw, "deploy/production/docker-compose.yml");
assertIncludes(raw, "deploy/production/deploy.sh");
assertIncludes(raw, "sudo env DOCKER_CONFIG=", "root-scoped Docker config");
assertIncludes(raw, "docker login ghcr.io");
assertIncludes(raw, "docker logout ghcr.io");
assertExcludes(raw, "| docker login ghcr.io", "unprivileged Docker login");
assertExcludes(raw, "cleanup() { docker logout ghcr.io", "unprivileged Docker logout");
assertIncludes(raw, "if: always()");
assertIncludes(raw, "rm -f");
assertIncludes(raw, "trap");
assertIncludes(raw, "install -d -m 0700 /tmp/expense-tax-deploy", "private remote staging directory");
assertIncludes(raw, "DOCKER_CONFIG=/dev/shm/expense-tax-docker-config", "ephemeral root Docker config");
assertIncludes(raw, "install -d -o root -g root -m 0700", "root-only Docker config directory");
assertIncludes(raw, "rm -rf \\\"\\$DOCKER_CONFIG\\\"", "Docker config cleanup");
assertIncludes(raw, "sudo env DOCKER_CONFIG=\\\"\\$DOCKER_CONFIG\\\"", "Docker config propagation");

const remoteCleanup = workflow.jobs?.deploy?.steps?.find(
  ({ name }) => name === "Clean remote staging",
);
assertEqual(remoteCleanup?.if, "always()", "remote cleanup condition");
assertIncludes(remoteCleanup?.run ?? "", "ssh ", "remote cleanup SSH call");
assertIncludes(remoteCleanup?.run ?? "", "docker logout ghcr.io", "remote cleanup Docker logout");
assertIncludes(remoteCleanup?.run ?? "", "/tmp/expense-tax-deploy", "remote staging cleanup");
assertIncludes(remoteCleanup?.run ?? "", "|| true", "best-effort remote cleanup");

const permissions = workflow.permissions ?? {};
assertEqual(permissions.contents, "read", "workflow contents permission");
assertEqual(workflow.jobs?.build?.permissions?.contents, "read", "build contents permission");
assertEqual(workflow.jobs?.build?.permissions?.packages, "write", "build packages permission");
assertEqual(workflow.jobs?.deploy?.permissions?.contents, "read", "deploy contents permission");
assertEqual(workflow.jobs?.deploy?.permissions?.packages, "read", "deploy packages permission");
assertEqual(workflow.jobs?.deploy?.permissions?.["id-token"], undefined, "deploy has no OIDC permission");
assertExcludes(raw, "permissions: write", "broad workflow permissions");

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Phase 1B deployment workflow static checks passed");
}
