"use client";
import { PageHead, Panel, Status } from "@/components/ui";
import { PersonalScopeUnavailable } from "@/components/scope-unavailable";
import { readOfficeSession } from "@/lib/session";

export default function Businesses() {
  const session = readOfficeSession();
  // Fail closed: null session (missing/corrupt) and personal scope both show unavailable.
  // Never render Business content without a verified business scope.
  if (!session || session.scope.kind !== "business") {
    return <PersonalScopeUnavailable feature="Businesses" />;
  }
  return (
    <>
      <PageHead eyebrow="Profiles + roles" title="Business boundaries stay visible." />
      <div className="two">
        <Panel title="Tran Studio">
          <p>Restaurant · America/New_York · USD</p>
          <p><Status>Owner</Status> 3 members · 2 projects</p>
        </Panel>
        <Panel title="Personal">
          <p>Separate membership and ledger. Tenant ownership grants no implicit access.</p>
          <Status tone="warn">Business-only invitee denied</Status>
        </Panel>
      </div>
    </>
  );
}
