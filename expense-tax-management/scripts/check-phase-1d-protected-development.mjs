import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";

function triggerOf(workflow) {
  return workflow.on ?? workflow["on"];
}

function equal(failures, actual, expected, label) {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

function includes(failures, source, value, label) {
  if (!source.includes(value)) failures.push(`${label}: missing ${value}`);
}

export function checkPhase1dProtectedDevelopment({ ciSource, deploySource, agentsSource }) {
  const failures = [];
  const ci = YAML.parse(ciSource);
  const deploy = YAML.parse(deploySource);
  const ciTrigger = triggerOf(ci);
  const deployTrigger = triggerOf(deploy);

  equal(failures, ci.name, "Expense Tax CI", "CI workflow name");
  equal(failures, ciTrigger?.push?.branches?.join(","), "main,master", "CI push branches");
  if (ciTrigger?.push?.paths?.join("|") !== "expense-tax-management/**|infrastructure/docker-compose.common.yml|.github/workflows/expense-tax-ci.yml") {
    failures.push("CI main push paths changed");
  }
  equal(failures, ciTrigger?.pull_request?.branches?.join(","), "dev", "CI pull-request branch");
  if (ciTrigger?.workflow_dispatch === undefined) failures.push("workflow_dispatch trigger missing");
  if (ciTrigger?.pull_request?.paths !== undefined) failures.push("pull_request must not define paths");
  if (ciTrigger?.pull_request?.["paths-ignore"] !== undefined) failures.push("pull_request must not define paths-ignore");
  equal(failures, ci.jobs?.quality?.name, "Contracts, services, workers, frontends", "required quality context");
  equal(failures, ci.jobs?.integration?.name, "Postgres, Temporal, cross-language, Docker", "advisory integration context");
  equal(failures, ci.jobs?.integration?.needs, "quality", "integration needs quality");
  if (ci.jobs?.integration?.["continue-on-error"] !== undefined) failures.push("integration must not use continue-on-error");
  equal(failures, ci.jobs?.["no-deploy"]?.needs?.join(","), "quality,integration", "no-deploy dependencies");

  const qualitySteps = ci.jobs?.quality?.steps ?? [];
  const checkoutStep = qualitySteps[0];
  const branchStep = qualitySteps[1];
  equal(failures, checkoutStep?.uses, "actions/checkout@v4", "quality checkout first step");
  equal(failures, branchStep?.name, "Enforce feature source branch", "quality first policy check name");
  equal(failures, branchStep?.if, "github.event_name == 'pull_request'", "quality branch guard condition");
  equal(failures, branchStep?.["working-directory"], ".", "quality policy check working directory");
  if (!(branchStep?.run ?? "").includes("feature/*)")) failures.push("quality first policy check must accept feature/*");
  includes(failures, branchStep?.run ?? "", "HEAD_REF", "quality branch guard must inspect github.head_ref");
  includes(failures, branchStep?.env?.HEAD_REF ?? "", "github.head_ref", "quality branch guard source");

  const qualityRuns = qualitySteps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run.split("\n").map((line) => line.trim()));
  for (const command of [
    "pnpm install --frozen-lockfile",
    "uv sync --frozen --project common/python/expense-contracts",
    "uv sync --frozen --project services/ai-worker",
    "pnpm --filter @expense-tax/contracts build",
    "pnpm contracts:check",
    "pnpm ci:lint",
    "pnpm ci:typecheck",
    "pnpm ci:test",
    "pnpm ci:build",
    "pnpm ci:python:lint",
    "pnpm ci:python:test",
  ]) {
    if (!qualityRuns.some((lines) => lines.includes(command))) {
      failures.push(`quality command ${command}: missing executable step`);
    }
  }

  equal(failures, deployTrigger?.workflow_run?.branches?.join(","), "main", "deployment workflow branch");
  const expectedDeploymentCondition = "github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository";
  if (["build", "deploy"].some((job) => {
    const jobFailures = [];
    equal(jobFailures, (deploy.jobs?.[job]?.if ?? "").trim(), expectedDeploymentCondition, `${job} deployment condition`);
    return jobFailures.length > 0;
  })) {
    failures.push("deployment workflow must remain main-only");
  }
  if (deployTrigger?.pull_request !== undefined) failures.push("deployment workflow must not trigger on pull_request");

  const agentsRules = [
    "Every coding-harness implementation session must use a git worktree.",
    "Refresh `origin/dev` before creating the worktree.",
    "Never commit directly on `dev` or `main`.",
    "Push only the feature branch, then open a pull request to `dev`.",
    "Unit/quality check must succeed before merge.",
    "Never bypass branch protection or force-push.",
  ];
  const gitSafetyHeading = "## Git Safety";
  const gitSafetyStart = agentsSource.indexOf(gitSafetyHeading);
  const nextHeading = gitSafetyStart === -1 ? -1 : agentsSource.indexOf("\n## ", gitSafetyStart + gitSafetyHeading.length);
  const gitSafetySection = gitSafetyStart === -1
    ? ""
    : agentsSource.slice(gitSafetyStart, nextHeading === -1 ? undefined : nextHeading);
  if (!gitSafetySection.includes("Create a `feature/*` branch from `origin/dev`.")) {
    failures.push("AGENTS.md must require feature/* worktrees");
  }
  for (const rule of agentsRules) includes(failures, gitSafetySection, rule, "AGENTS.md policy");
  if (gitSafetySection.includes("- Work on current branch; no feature branches.")) failures.push("AGENTS.md retains contradictory Git Safety rule");

  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = path.resolve(appRoot, "..");
  const failures = checkPhase1dProtectedDevelopment({
    ciSource: await readFile(path.join(repoRoot, ".github/workflows/expense-tax-ci.yml"), "utf8"),
    deploySource: await readFile(path.join(repoRoot, ".github/workflows/expense-tax-deploy.yml"), "utf8"),
    agentsSource: await readFile(path.join(appRoot, "AGENTS.md"), "utf8"),
  });
  if (failures.length) {
    console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("PASS Phase 1D protected development static checks");
  }
}
