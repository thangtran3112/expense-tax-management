import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { checkPhase1dProtectedDevelopment } from "./check-phase-1d-protected-development.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");

async function readPolicyInputs() {
  return {
    ciSource: await readFile(path.join(repoRoot, ".github/workflows/expense-tax-ci.yml"), "utf8"),
    deploySource: await readFile(path.join(repoRoot, ".github/workflows/expense-tax-deploy.yml"), "utf8"),
    agentsSource: await readFile(path.join(appRoot, "AGENTS.md"), "utf8"),
  };
}

describe("Phase 1D protected development policy", () => {
  it("accepts the repository policy", async () => {
    expect(checkPhase1dProtectedDevelopment(await readPolicyInputs())).toEqual([]);
  });

  it("rejects a pull-request path filter", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace('  pull_request:\n    branches: [dev]\n', '  pull_request:\n    branches: [dev]\n    paths:\n      - "expense-tax-management/**"\n');
    expect(checkPhase1dProtectedDevelopment(input)).toContain("pull_request must not define paths");
  });

  it("rejects a pull-request path exclusion filter", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace('  pull_request:\n    branches: [dev]\n', '  pull_request:\n    branches: [dev]\n    paths-ignore:\n      - "docs/**"\n');
    expect(checkPhase1dProtectedDevelopment(input)).toContain("pull_request must not define paths-ignore");
  });

  it("rejects a non-feature source branch guard", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace("feature/*", "bugfix/*");
    expect(checkPhase1dProtectedDevelopment(input)).toContain("quality first policy check must accept feature/*");
  });

  it("rejects a changed main deployment workflow", async () => {
    const input = await readPolicyInputs();
    input.deploySource = input.deploySource.replaceAll("github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.head_branch == 'dev'");
    expect(checkPhase1dProtectedDevelopment(input)).toContain("deployment workflow must remain main-only");
  });

  it("rejects a broadened deployment job condition", async () => {
    const input = await readPolicyInputs();
    const deploy = YAML.parse(input.deploySource);
    const exactCondition = deploy.jobs.build.if;
    deploy.jobs.build.if = `${exactCondition} || github.event.workflow_run.head_branch == 'dev'`;
    input.deploySource = YAML.stringify(deploy);
    expect(checkPhase1dProtectedDevelopment(input)).toContain("deployment workflow must remain main-only");
  });

  it("rejects contradictory Git Safety rules", async () => {
    const input = await readPolicyInputs();
    input.agentsSource = input.agentsSource.replace("Create a `feature/*` branch", "Work on current branch");
    expect(checkPhase1dProtectedDevelopment(input)).toContain("AGENTS.md must require feature/* worktrees");
  });

  it("requires feature worktree policy inside Git Safety", async () => {
    const input = await readPolicyInputs();
    const requiredRule = "Create a `feature/*` branch from `origin/dev`.";
    input.agentsSource = input.agentsSource.replace(
      "## Architecture\n",
      `## Architecture\n\n- ${requiredRule}\n`,
    );
    const gitSafetyStart = input.agentsSource.indexOf("## Git Safety\n");
    const actualRuleStart = input.agentsSource.indexOf(`- ${requiredRule}\n`, gitSafetyStart);
    input.agentsSource = `${input.agentsSource.slice(0, actualRuleStart)}- Work on current branch; no feature branches.\n${input.agentsSource.slice(actualRuleStart + `- ${requiredRule}\n`.length)}`;
    expect(checkPhase1dProtectedDevelopment(input)).toContain("AGENTS.md must require feature/* worktrees");
  });

  it("rejects a required command that exists only in a YAML comment", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace("        run: pnpm ci:lint", "        run: '# pnpm ci:lint'");
    input.ciSource += "\n# pnpm ci:lint\n";
    expect(checkPhase1dProtectedDevelopment(input)).toContain("quality command pnpm ci:lint: missing executable step");
  });

  it("requires the exact required status-check context", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace(
      "    name: Contracts, services, workers, frontends",
      "    name: Contracts, services, workers, frontends (renamed)",
    );
    expect(checkPhase1dProtectedDevelopment(input).length).toBeGreaterThan(0);
  });

  it("requires integration to need quality", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace("  integration:\n    name: Postgres, Temporal, cross-language, Docker\n    needs: quality", "  integration:\n    name: Postgres, Temporal, cross-language, Docker\n    needs: integration");
    expect(checkPhase1dProtectedDevelopment(input).length).toBeGreaterThan(0);
  });

  it("rejects continue-on-error in protected CI", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace("    timeout-minutes: 60\n", "    timeout-minutes: 60\n    continue-on-error: true\n");
    expect(checkPhase1dProtectedDevelopment(input).length).toBeGreaterThan(0);
  });

  it("requires main push branches", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace("    branches: [main, master]\n", "    branches: [master]\n");
    expect(checkPhase1dProtectedDevelopment(input).length).toBeGreaterThan(0);
  });

  it("requires pull requests to target dev", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace("  pull_request:\n    branches: [dev]\n", "  pull_request:\n    branches: [main]\n");
    expect(checkPhase1dProtectedDevelopment(input).length).toBeGreaterThan(0);
  });

  it("preserves no-deploy needs for quality and integration", async () => {
    const input = await readPolicyInputs();
    input.ciSource = input.ciSource.replace("    needs: [quality, integration]", "    needs: [quality]");
    expect(checkPhase1dProtectedDevelopment(input).length).toBeGreaterThan(0);
  });
});
