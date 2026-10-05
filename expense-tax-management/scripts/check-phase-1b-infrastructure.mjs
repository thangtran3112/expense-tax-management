import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const infrastructureDir = join(scriptDir, "../infrastructure/gcp/expense-tax");
const bootstrap = readFileSync(join(infrastructureDir, "bootstrap.sh"), "utf8");
const readme = readFileSync(join(infrastructureDir, "README.md"), "utf8");
const agents = readFileSync(join(scriptDir, "../AGENTS.md"), "utf8");

const failures = [];
function assertIncludes(source, expected, label = expected) {
  if (!source.includes(expected)) failures.push(`missing: ${label}`);
}
function assertExcludes(source, forbidden, label = forbidden) {
  if (source.includes(forbidden)) failures.push(`forbidden: ${label}`);
}
function assertBefore(source, first, second, label = `${first} before ${second}`) {
  if (source.indexOf(first) === -1 || source.indexOf(second) === -1 || source.indexOf(first) > source.indexOf(second)) {
    failures.push(`ordering: ${label}`);
  }
}
function commandBlocks(source, prefix) {
  const lines = source.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trimStart().startsWith(prefix)) continue;
    const block = [lines[index].trim()];
    while (block.at(-1).endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      block.push(lines[index].trim());
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}
function assertIamBindingTuples(source) {
  const serviceAccountBlocks = commandBlocks(
    source,
    "gcloud iam service-accounts ",
  ).filter((block) => block.includes("iam-policy-binding"));
  const expected = [
    {
      action: "remove",
      role: "roles/iam.workloadIdentityUser",
      member: 'principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/subject/repo:${REPOSITORY}:environment:production',
    },
    {
      action: "add",
      role: "roles/iam.workloadIdentityUser",
      member: "$PRINCIPAL_SET",
    },
  ];
  const actual = serviceAccountBlocks.map((block) => ({
    action: block.includes(" remove-") ? "remove" : block.includes(" add-") ? "add" : "unknown",
    role: block.match(/--role="([^"]+)"/u)?.[1],
    member: block.match(/--member="([^"]+)"/u)?.[1],
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push("IAM service-account binding command tuples changed");
  }

  const secretBlocks = commandBlocks(source, "gcloud secrets add-iam-policy-binding ");
  const expectedSecret = {
    role: "roles/secretmanager.secretAccessor",
    member: "serviceAccount:${SERVICE_ACCOUNT_EMAIL}",
  };
  const actualSecret = secretBlocks.map((block) => ({
    role: block.match(/--role="([^"]+)"/u)?.[1],
    member: block.match(/--member="([^"]+)"/u)?.[1],
  }));
  if (secretBlocks.length !== 1 || JSON.stringify(actualSecret) !== JSON.stringify([expectedSecret])) {
    failures.push("Secret accessor binding command tuple changed");
  }
}

assertIncludes(bootstrap, 'PROJECT_ID="expense-tax-tobytran-2026"');
assertIncludes(bootstrap, 'BILLING_ACCOUNT="013C6D-EEE26E-EAA1A1"');
assertExcludes(bootstrap, "013C6D-EEE26-EAA1A1", "invalid billing account typo");
assertIncludes(bootstrap, 'SECRET_ID="expense-tax-production-env"');
assertIncludes(bootstrap, 'SERVICE_ACCOUNT_ID="expense-tax-github-deploy"');
assertIncludes(bootstrap, 'POOL_ID="expense-tax-github"');
assertIncludes(bootstrap, 'PROVIDER_ID="github"');
assertIncludes(bootstrap, 'REPOSITORY="thangtran3112/family-app"');
assertIncludes(bootstrap, "gcloud projects create");
assertIncludes(bootstrap, '--organization="$ORGANIZATION_ID"');
assertIncludes(bootstrap, "cloudresourcemanager.googleapis.com");
assertIncludes(bootstrap, "parent.id");
assertIncludes(bootstrap, "billingAccountName");
assertIncludes(bootstrap, "verify_project_contract");
assertIncludes(bootstrap, "billing projects link");
assertIncludes(bootstrap, "services enable");
assertIncludes(bootstrap, "iam service-accounts create");
assertIncludes(bootstrap, "iam workload-identity-pools create");
assertIncludes(bootstrap, "iam workload-identity-pools providers create-oidc");
assertIncludes(bootstrap, "assertion.repository=='thangtran3112/family-app'");
assertIncludes(bootstrap, "assertion.ref=='refs/heads/main'");
assertIncludes(bootstrap, "assertion.workflow_ref=='thangtran3112/family-app/.github/workflows/expense-tax-deploy.yml@refs/heads/main'");
assertIncludes(bootstrap, "assertion.workflow_ref=='thangtran3112/family-app/.github/workflows/expense-tax-cloudflare.yml@refs/heads/main'");
assertIncludes(bootstrap, "assertion.environment=='production'");
assertIncludes(bootstrap, 'WIF_ATTRIBUTE_CONDITION="assertion.repository==\'thangtran3112/family-app\' && assertion.ref==\'refs/heads/main\' && (assertion.workflow_ref==\'thangtran3112/family-app/.github/workflows/expense-tax-deploy.yml@refs/heads/main\' || assertion.workflow_ref==\'thangtran3112/family-app/.github/workflows/expense-tax-cloudflare.yml@refs/heads/main\') && assertion.environment==\'production\'"');
assertIncludes(bootstrap, "attributeMapping");
assertIncludes(bootstrap, 'provider.attributeMapping?.["google.subject"]');
assertIncludes(bootstrap, 'provider.attributeMapping?.["attribute.repository"]');
assertIncludes(bootstrap, "provider.oidc?.issuerUri");
assertExcludes(bootstrap, "issuerUri: provider.issuerUri", "incorrect gcloud provider issuer path");
assertIncludes(bootstrap, "issuerUri");
assertIncludes(bootstrap, "attributeCondition");
assertIncludes(bootstrap, "roles/iam.workloadIdentityUser");
assertIncludes(bootstrap, "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPOSITORY}");
assertIncludes(bootstrap, 'PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPOSITORY}"');
assertIncludes(bootstrap, 'members.includes(expected)');
assertIncludes(bootstrap, "members.length !== 1");
assertExcludes(bootstrap, "PRINCIPAL_SUBJECT", "unsupported environment subject binding");
assertExcludes(bootstrap, '--member="$PRINCIPAL_SUBJECT"', "unsupported subject principal binding");
assertIncludes(bootstrap, "roles/secretmanager.secretAccessor");
assertIncludes(bootstrap, "--format=json");
assertIncludes(bootstrap, "trap cleanup EXIT");
assertIncludes(bootstrap, 'rm -rf "$TEMP_DIR"');
assertBefore(bootstrap, "umask 077", 'TEMP_DIR="');
assertExcludes(bootstrap, "service-accounts keys create");
assertIncludes(readme, "expense-tax-tobytran-2026");
assertIncludes(readme, "expense-tax-production-env");
assertIncludes(readme, "013C6D-EEE26E-EAA1A1");
assertExcludes(readme, "013C6D-EEE26-EAA1A1", "invalid billing account typo");
assertIncludes(readme, "family-config");
assertIncludes(bootstrap, 'OUTPUT_FILE="${1:-/dev/stdout}"');
assertIncludes(agents, "013C6D-EEE26E-EAA1A1");
assertExcludes(agents, "013C6D-EEE26-EAA1A1", "invalid billing account typo");
assertIamBindingTuples(bootstrap);

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Phase 1B infrastructure static checks passed");
}
