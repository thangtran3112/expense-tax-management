import type { Scope } from "@expense-tax/contracts";

export interface OfficeSession {
  apiBaseUrl: string;
  tenantId: string;
  scope: Scope;
  label: string;
}

export function readOfficeSession(): OfficeSession | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem("expense-tax-office-session");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // Validate required shape: fail closed when tenant/scope/membership missing
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.apiBaseUrl !== "string" || !obj.apiBaseUrl) return null;
    if (typeof obj.tenantId !== "string" || !obj.tenantId) return null;
    if (typeof obj.label !== "string") return null;
    if (!obj.scope || typeof obj.scope !== "object") return null;
    const scope = obj.scope as Record<string, unknown>;
    if (scope.kind === "personal") {
      if (typeof scope.profileId !== "string" || !scope.profileId) return null;
      return { apiBaseUrl: obj.apiBaseUrl, tenantId: obj.tenantId, label: obj.label, scope: { kind: "personal", profileId: scope.profileId } };
    }
    if (scope.kind === "business") {
      if (typeof scope.businessId !== "string" || !scope.businessId) return null;
      return { apiBaseUrl: obj.apiBaseUrl, tenantId: obj.tenantId, label: obj.label, scope: { kind: "business", businessId: scope.businessId } };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeOfficeSession(session: OfficeSession): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem("expense-tax-office-session", JSON.stringify(session));
}

export function clearOfficeSession(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem("expense-tax-office-session");
}
