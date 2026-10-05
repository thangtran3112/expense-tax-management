import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const appRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = join(appRoot, "..");
const moduleRoot = join(repoRoot, "infrastructure/cloudflare/expense-tax");
const read = (file) => readFileSync(join(moduleRoot, file), "utf8");
const main = read("main.tf");
const readme = read("README.md");
const state = read("bootstrap-state.sh");
const cloudflareBootstrap = readFileSync(
  join(repoRoot, "expense-tax-management/infrastructure/gcp/expense-tax/bootstrap-cloudflare.sh"),
  "utf8",
);
const appBootstrap = readFileSync(
  join(repoRoot, "expense-tax-management/infrastructure/gcp/expense-tax/bootstrap.sh"),
  "utf8",
);
const vps = readFileSync(join(repoRoot, "infrastructure/vps/bootstrap-cloudflared.sh"), "utf8");
const workflowRaw = readFileSync(join(repoRoot, ".github/workflows/expense-tax-cloudflare.yml"), "utf8");
const workflow = YAML.parse(workflowRaw);
const failures = [];
const legacyServiceAccountId = ["expense-tax-cloudflare", "terraform"].join("-");
const pullRequestJob = workflow.jobs?.validate;
const planJob = workflow.jobs?.plan;
const applyJob = workflow.jobs?.apply;
export const TRUSTED_PLAN_CONDITION =
  "(github.event_name == 'push' && github.ref == 'refs/heads/main') || " +
  "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')";
export const APPLY_CONDITION =
  "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.apply == true";

export function conditionIsExactly(actual, expected) {
  return String(actual ?? "").replace(/\s+/gu, " ").trim() ===
    String(expected).replace(/\s+/gu, " ").trim();
}

function includes(source, value, label = value) {
  if (!source.includes(value)) failures.push(`missing: ${label}`);
}

function excludes(source, value, label = value) {
  if (source.includes(value)) failures.push(`forbidden: ${label}`);
}

includes(main, 'version = ">= 5.8.2, < 6.0.0"');
includes(main, 'backend "gcs"');
includes(main, 'prefix = "cloudflare/expense-tax"');
includes(main, 'config_src = "cloudflare"');
includes(main, 'service  = "http://127.0.0.1:7301"');
includes(main, 'service  = "http://127.0.0.1:8100"');
includes(main, 'service  = "http://127.0.0.1:7302"');
includes(main, 'service  = "http://127.0.0.1:7303"');
includes(main, 'service  = "http://127.0.0.1:8300"');
includes(main, 'path     = "/oauth/google/callback"');
includes(main, 'path     = "/oauth/google/begin"');
includes(main, 'service = "http_status:404"');
includes(main, 'type    = "CNAME"');
includes(main, 'proxied = true');
includes(main, '.cfargotunnel.com');
excludes(main, "expense-clerk", "Clerk hostname in tunnel Terraform");
includes(readme, "Account: **Cloudflare Tunnel Edit**");
includes(readme, "Zone: **DNS Edit**");
includes(readme, "expense-clerk.tobytran.dev");
includes(readme, "DNS-only");
includes(vps, "TOKEN_MODE");
includes(vps, "0600");
includes(vps, "stat -c '%a'");
includes(vps, "stat -f '%Lp'");
includes(vps, "2025.4.0");
includes(vps, "apt-get install -y cloudflared");
includes(vps, "--token-file /etc/cloudflared/expense-tax-tunnel.token");
includes(vps, "pkg.cloudflare.com/cloudflared");
includes(vps, "--known-hosts-file");
includes(vps, "UserKnownHostsFile");
includes(vps, "StrictHostKeyChecking=yes");
excludes(vps, "cat \"$TOKEN_FILE\"", "token content command substitution");
excludes(vps, "StrictHostKeyChecking=accept-new", "unverified SSH host key acceptance");

if (!pullRequestJob) failures.push("missing: unprivileged PR validation job");
if (!planJob || !applyJob) failures.push("missing: plan/apply jobs");
if (pullRequestJob?.permissions?.["id-token"] !== "none") {
  failures.push("PR validation must not receive OIDC permission");
}
if (pullRequestJob?.environment) failures.push("PR validation must not use production environment");
if (pullRequestJob?.env?.TF_VAR_cloudflare_api_token) {
  failures.push("PR validation must not receive Cloudflare API token");
}
const pullRequestRun = pullRequestJob?.steps?.find((step) => String(step.name).includes("Terraform init"))?.run ?? "";
includes(pullRequestRun, "terraform init -backend=false", "PR Terraform init with backend disabled");
if (planJob?.environment !== "production") failures.push("trusted plan must use production environment");
if (planJob?.permissions?.["id-token"] !== "write") {
  failures.push("trusted plan must receive OIDC permission");
}
if (!conditionIsExactly(planJob?.if, TRUSTED_PLAN_CONDITION)) {
  failures.push("trusted plan must allow only main push or manual dispatch");
}
if (applyJob?.environment !== "production") failures.push("apply must use production environment");
if (applyJob?.permissions?.["id-token"] !== "write") {
  failures.push("apply must receive OIDC permission");
}
if (!conditionIsExactly(applyJob?.if, APPLY_CONDITION)) {
  failures.push("apply must require main manual dispatch with approval");
}
includes(workflowRaw, "google-github-actions/auth@v3");
includes(workflowRaw, "hashicorp/setup-terraform@v3");
includes(workflowRaw, "terraform init");
includes(workflowRaw, "terraform validate");
includes(workflowRaw, "terraform plan");
includes(workflowRaw, "terraform apply");
// Saved plans embed input variable values and the prior state (including the
// tunnel token output); on a public repository artifacts are downloadable by
// any signed-in GitHub user. Plans must never leave the job that created them.
excludes(workflowRaw, "upload-artifact", "Terraform plan artifact upload");
excludes(workflowRaw, "download-artifact", "Terraform plan artifact download");
const jobRuns = (job) => (job?.steps ?? []).map((step) => String(step.run ?? "")).join("\n");
includes(jobRuns(planJob), "rm -f tfplan", "plan job deletes its local plan file");
includes(jobRuns(planJob), "plan-change-digest.sh", "plan job publishes reviewed change digest");
includes(jobRuns(applyJob), "plan-change-digest.sh", "apply job verifies reviewed change digest");
includes(workflowRaw, "needs.plan.outputs.change_digest", "apply job compares against reviewed digest");
includes(jobRuns(applyJob), "terraform plan -out=tfplan", "apply job creates its own plan");
includes(jobRuns(applyJob), "terraform apply -auto-approve tfplan", "apply job applies only its own plan");
const variables = read("variables.tf");
const tokenVariable = variables.match(/variable "cloudflare_api_token" \{[\s\S]*?\n\}/u)?.[0] ?? "";
if (!/ephemeral\s+=\s+true/u.test(tokenVariable)) {
  failures.push("missing: ephemeral Cloudflare API token variable (kept out of plans and state)");
}
includes(main, 'required_version = ">= 1.10.0"', "Terraform version supporting ephemeral variables");
includes(workflowRaw, "GCP_CLOUDFLARE_WORKLOAD_IDENTITY_PROVIDER");
includes(workflowRaw, "GCP_CLOUDFLARE_SERVICE_ACCOUNT");
excludes(workflowRaw, "GCP_WORKLOAD_IDENTITY_PROVIDER", "shared application WIF provider");
excludes(workflowRaw, "GCP_DEPLOY_SERVICE_ACCOUNT", "shared application deploy service account");
includes(workflowRaw, "environment: production");
includes(workflowRaw, "inputs.apply == true");
includes(workflowRaw, "-backend=false", "PR validation backend disabled");
includes(state, "verify_bucket_project", "state bucket project verification");
includes(state, "daysSinceNoncurrentTime", "state noncurrent lifecycle policy");
includes(state, "CLOUDFLARE_TERRAFORM_SERVICE_ACCOUNT", "dedicated Cloudflare state identity");
includes(state, "expense-tax-cf-terraform@expense-tax-tobytran-2026.iam.gserviceaccount.com", "stable Cloudflare service account");
excludes(state, legacyServiceAccountId, "overlong Cloudflare service account ID");
includes(state, "remove-iam-policy-binding", "remove application state access");
includes(cloudflareBootstrap, 'SERVICE_ACCOUNT_ID="expense-tax-cf-terraform"', "stable Cloudflare service account ID");
excludes(cloudflareBootstrap, legacyServiceAccountId, "overlong Cloudflare service account ID");
includes(cloudflareBootstrap, "expense-tax-cloudflare.yml@refs/heads/main", "exact Cloudflare workflow WIF admission");
includes(cloudflareBootstrap, "refs/heads/main", "Cloudflare WIF main branch admission");
includes(cloudflareBootstrap, "assertion.environment=='production'", "Cloudflare WIF production admission");
excludes(cloudflareBootstrap, "secretmanager.secretAccessor", "application Secret Manager access");
excludes(cloudflareBootstrap, "roles/run.", "application deploy permissions");
excludes(appBootstrap, "expense-tax-cloudflare.yml", "Cloudflare workflow in application WIF admission");
excludes(workflowRaw, "expense-tax-management/deploy/production", "application deployment in Cloudflare workflow");
excludes(workflowRaw, "docker push", "container deployment in Cloudflare workflow");

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Cloudflare infrastructure static checks passed");
}
