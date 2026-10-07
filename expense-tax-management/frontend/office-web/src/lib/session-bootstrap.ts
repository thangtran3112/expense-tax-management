import {
  createAppApiClient,
  type PersonalProfile,
  type Scope,
  type SmallBusiness,
  type Tenant,
  type TenantScopes,
} from "@expense-tax/contracts";

import { getAppAuthorization, type ClerkGetToken } from "./clerk";
import { readOfficeSession, writeOfficeSession, type OfficeSession } from "./session";

type AppApiClient = ReturnType<typeof createAppApiClient>;

export type BootstrapResult =
  | { status: "ok"; session: OfficeSession }
  | { status: "error"; message: string };

interface ScopeChoice {
  readonly scope: Scope;
  readonly label: string;
}

/**
 * Web session wiring design (2026-10-06), step 2: pick a tenant -- the
 * remembered one if still listed, else the only one. Multiple tenants
 * with no remembered match is out of scope (production has one tenant);
 * callers show the same "no workspace" message either way.
 */
export function pickTenant(
  tenants: readonly Tenant[],
  rememberedTenantId: string | null,
): Tenant | null {
  if (rememberedTenantId) {
    const remembered = tenants.find((tenant) => tenant.id === rememberedTenantId);
    if (remembered) return remembered;
  }
  return tenants.length === 1 ? tenants[0]! : null;
}

/**
 * Step 4: choose the remembered scope if still listed, else the personal
 * profile, else the first business.
 */
export function pickScope(
  scopes: TenantScopes,
  remembered: ScopeChoice | null,
): ScopeChoice | null {
  if (remembered) {
    const match =
      remembered.scope.kind === "personal"
        ? findPersonal(scopes.personalProfiles, remembered.scope.profileId)
        : findBusiness(scopes.businesses, remembered.scope.businessId);
    if (match) return match;
  }
  const [profile] = scopes.personalProfiles;
  if (profile) return { scope: { kind: "personal", profileId: profile.id }, label: profile.name };
  const [business] = scopes.businesses;
  if (business) return { scope: { kind: "business", businessId: business.id }, label: business.name };
  return null;
}

function findPersonal(
  profiles: readonly PersonalProfile[],
  profileId: string,
): ScopeChoice | null {
  const profile = profiles.find((candidate) => candidate.id === profileId);
  return profile ? { scope: { kind: "personal", profileId: profile.id }, label: profile.name } : null;
}

function findBusiness(
  businesses: readonly SmallBusiness[],
  businessId: string,
): ScopeChoice | null {
  const business = businesses.find((candidate) => candidate.id === businessId);
  return business ? { scope: { kind: "business", businessId: business.id }, label: business.name } : null;
}

/**
 * Session bootstrap: loads the user's tenants, picks one, loads their
 * scopes, picks a scope, and writes the session -- run from the
 * signed-in shell (OfficeAuthGate) whenever no valid session exists.
 */
export async function bootstrapOfficeSession(
  input: {
    readonly getToken: ClerkGetToken;
    readonly organizationId: string | null | undefined;
    readonly apiBaseUrl: string;
  },
  client: AppApiClient = createAppApiClient(input.apiBaseUrl),
): Promise<BootstrapResult> {
  const existing = readOfficeSession();
  const authorization = await getAppAuthorization(input.getToken, input.organizationId);

  const tenants = await client.GET("/api/v1/tenants", { headers: authorization });
  if (tenants.error || !tenants.data) {
    return { status: "error", message: "Could not load your workspace." };
  }
  const tenant = pickTenant(tenants.data.items, existing?.tenantId ?? null);
  if (!tenant) {
    return {
      status: "error",
      message:
        tenants.data.items.length === 0
          ? "No workspace is set up yet."
          : "Choose a workspace first.",
    };
  }

  const scopes = await client.GET("/api/v1/tenants/{tenantId}/scopes", {
    params: { path: { tenantId: tenant.id } },
    headers: authorization,
  });
  if (scopes.error || !scopes.data) {
    return { status: "error", message: "Could not load your profiles." };
  }
  const remembered =
    existing && existing.tenantId === tenant.id
      ? { scope: existing.scope, label: existing.label }
      : null;
  const picked = pickScope(scopes.data, remembered);
  if (!picked) {
    return { status: "error", message: "No profile is available yet. Ask an owner for access." };
  }

  const session: OfficeSession = {
    apiBaseUrl: input.apiBaseUrl,
    tenantId: tenant.id,
    scope: picked.scope,
    label: picked.label,
  };
  writeOfficeSession(session);
  return { status: "ok", session };
}
