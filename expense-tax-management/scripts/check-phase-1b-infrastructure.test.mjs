import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const bootstrapScript = join(
  projectRoot,
  "infrastructure/gcp/expense-tax/bootstrap.sh",
);

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

describe("GCP bootstrap static policy", () => {
  it("uses valid billing account identifier and rejects known typo", async () => {
    const bootstrap = await readFile(bootstrapScript, "utf8");

    expect(bootstrap).toContain('BILLING_ACCOUNT="013C6D-EEE26E-EAA1A1"');
    expect(bootstrap).not.toContain("013C6D-EEE26-EAA1A1");
  });

  it("validates WIF issuer at current gcloud provider schema path", async () => {
    const bootstrap = await readFile(bootstrapScript, "utf8");

    expect(bootstrap).toContain("provider.oidc?.issuerUri");
    expect(bootstrap).not.toContain("issuerUri: provider.issuerUri");
  });

  it("pins WIF condition and repository principal-set binding", async () => {
    const bootstrap = await readFile(bootstrapScript, "utf8");

    for (const claim of [
      "assertion.repository=='thangtran3112/family-app'",
      "assertion.ref=='refs/heads/main'",
      "assertion.workflow_ref=='thangtran3112/family-app/.github/workflows/expense-tax-deploy.yml@refs/heads/main'",
      "assertion.environment=='production'",
    ]) {
      expect(bootstrap).toContain(claim);
    }
    expect(bootstrap).not.toContain("expense-tax-cloudflare.yml");
    expect(bootstrap).toContain("PRINCIPAL_SET");
    expect(bootstrap).toContain("attribute.repository/${REPOSITORY}");
    expect(bootstrap).not.toContain("PRINCIPAL_SUBJECT");
    expect(bootstrap).not.toContain('--member="$PRINCIPAL_SUBJECT"');
    expect(bootstrap).toContain("gcloud iam service-accounts get-iam-policy");
    expect(bootstrap).toContain("WIF service-account binding drift");
  });

  it("binds exact IAM action, role, and member tuples", async () => {
    const bootstrap = await readFile(bootstrapScript, "utf8");
    const serviceAccountBlocks = commandBlocks(bootstrap, "gcloud iam service-accounts ")
      .filter((block) => block.includes("iam-policy-binding"));
    expect(serviceAccountBlocks).toHaveLength(2);
    expect(serviceAccountBlocks).toEqual(expect.arrayContaining([
      expect.stringMatching(/remove-iam-policy-binding[\s\S]*--role="roles\/iam\.workloadIdentityUser"[\s\S]*--member="principal:\/\/iam\.googleapis\.com\/projects\/\$\{PROJECT_NUMBER\}\/locations\/global\/workloadIdentityPools\/\$\{POOL_ID\}\/subject\/repo:\$\{REPOSITORY\}:environment:production"/u),
      expect.stringMatching(/add-iam-policy-binding[\s\S]*--role="roles\/iam\.workloadIdentityUser"[\s\S]*--member="\$PRINCIPAL_SET"/u),
    ]));
    expect(commandBlocks(bootstrap, "gcloud secrets add-iam-policy-binding ")).toEqual([
      expect.stringMatching(/--role="roles\/secretmanager\.secretAccessor"[\s\S]*--member="serviceAccount:\$\{SERVICE_ACCOUNT_EMAIL\}"/u),
    ]);
  });
});
