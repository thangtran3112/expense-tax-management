import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import YAML from "yaml";

const readPackage = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readRepo = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("workflow-worker image builds pinned dependencies and runs without root", () => {
  const dockerfile = readPackage("services/workflow-worker/Dockerfile");
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS build/);
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS runtime/);
  assert.match(dockerfile, /pnpm@11\.9\.0/);
  assert.match(dockerfile, /pnpm install --frozen-lockfile/);
  assert.match(dockerfile, /@expense-tax\/contracts build/);
  assert.match(dockerfile, /@expense-tax\/workflow-worker build/);
  assert.match(dockerfile, /COPY --from=build .*services\/workflow-worker\/dist/);
  assert.match(dockerfile, /USER app/);
  assert.match(dockerfile, /CMD \["node", "dist\/worker\.js"\]/);
  assert.doesNotMatch(dockerfile, /COPY .*\.env/);
});

test("worker joins immutable main-only image builds", () => {
  const deploy = YAML.parse(readRepo(".github/workflows/expense-tax-deploy.yml"));
  assert.deepEqual(deploy.on.workflow_run.branches, ["main"]);
  for (const job of [deploy.jobs.build, deploy.jobs.deploy]) {
    assert.match(job.if, /workflow_run\.head_branch == 'main'/);
  }
  const images = deploy.jobs.build.strategy.matrix.include;
  assert.deepEqual(images.find(({ image }) => image === "expense-tax-workflow-worker"), {
    image: "expense-tax-workflow-worker",
    dockerfile: "expense-tax-management/services/workflow-worker/Dockerfile",
  });
});

test("Phase 3D-A Task 5: mailbox broker joins the immutable main-only image matrix", () => {
  const deploy = YAML.parse(readRepo(".github/workflows/expense-tax-deploy.yml"));
  const images = deploy.jobs.build.strategy.matrix.include;
  assert.deepEqual(images.find(({ image }) => image === "expense-tax-mailbox-broker"), {
    image: "expense-tax-mailbox-broker",
    dockerfile: "expense-tax-management/services/mailbox-broker/Dockerfile",
  });
});

test("production Compose runs workflow-worker on expense-tax/expense-tax-processing", () => {
  const compose = YAML.parse(readPackage("deploy/production/docker-compose.yml"));
  const worker = compose.services["workflow-worker"];
  assert.ok(worker, "production Compose must define a workflow-worker service");
  assert.equal(
    worker.image,
    "ghcr.io/thangtran3112/family-app/expense-tax-workflow-worker:${IMAGE_TAG}",
  );
  assert.equal(worker.environment.TEMPORAL_NAMESPACE, "expense-tax");
  assert.equal(worker.environment.AI_WORKER_TASK_QUEUE, "expense-tax-processing");
  assert.deepEqual(worker.networks, ["default", "shared"]);
  assert.equal(compose.services["ai-worker"], undefined);
});

test("required quality commands include worker checks and image boundary", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const command of ["ci:lint", "ci:typecheck", "ci:test", "ci:build"]) {
    assert.match(scripts[command], /@expense-tax\/workflow-worker/);
  }
  assert.match(scripts["ci:test"], /check:worker-image/);
  assert.equal(scripts["check:worker-image"], "node --test scripts/check-workflow-worker-image.test.mjs");
});
