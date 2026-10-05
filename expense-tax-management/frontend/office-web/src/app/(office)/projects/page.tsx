"use client";
import { Metric, PageHead, Panel } from "@/components/ui";
import { PersonalScopeUnavailable } from "@/components/scope-unavailable";
import { readOfficeSession } from "@/lib/session";

export default function Projects() {
  const session = readOfficeSession();
  if (!session || session.scope.kind !== "business") {
    return <PersonalScopeUnavailable feature="Projects" />;
  }
  return (
    <>
      <PageHead eyebrow="Client/job costs" title="Projects are analysis, not tax entities." />
      <div className="metrics">
        <Metric label="Acme launch" value="$4,281.20" note="38 expenses" />
        <Metric label="Client refresh" value="$1,120.00" note="12 expenses" />
        <Metric label="Internal" value="$620.10" note="9 expenses" />
      </div>
      <Panel title="Monthly project cost">
        <div className="bars">
          <i style={{ height: "44%" }} />
          <i style={{ height: "68%" }} />
          <i style={{ height: "86%" }} />
          <i style={{ height: "58%" }} />
        </div>
        <p>Accessible table alternative appears below charts in implementation state fixtures.</p>
      </Panel>
    </>
  );
}
