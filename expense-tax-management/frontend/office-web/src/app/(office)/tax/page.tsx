"use client";
import { OfficeData } from "@/components/office-data";
import { PageHead, Panel, Status } from "@/components/ui";
import { PersonalScopeUnavailable } from "@/components/scope-unavailable";
import { loadTaxForOffice } from "@/lib/page-data";
import { readOfficeSession } from "@/lib/session";

export default function Tax() {
  const session = readOfficeSession();
  if (!session || session.scope.kind !== "business") {
    return <PersonalScopeUnavailable feature="Tax" />;
  }
  return (
    <OfficeData load={loadTaxForOffice}>
      {(report) => (
        <>
          <PageHead eyebrow="2025 Schedule C" title="Prepare. Review. Export.">
            <p>No filing action or filing claim.</p>
          </PageHead>
          <div className="two">
            <Panel title="Year totals">
              <strong className="hero-number">{report.totals.grossTotal} {report.totals.currency}</strong>
              <p>Gross base-currency expenses · {report.totals.deductibleTotal} deductible</p>
              <Status tone={report.foreignCurrencySummary.excludedCount ? "warn" : "ok"}>{report.foreignCurrencySummary.excludedCount} foreign currency excluded</Status>
            </Panel>
            <Panel title="Review state">
              <ul className="list">
                <li>Reviewed <b>{report.review.reviewed}</b></li>
                <li>Unreviewed <b>{report.review.unreviewed}</b></li>
                <li>Missing treatment <b>{report.review.missingTreatment}</b></li>
              </ul>
            </Panel>
          </div>
          <Panel title="Tax category preparation">
            <div className="category-grid">
              {report.byCategory.map((c) => (
                <div key={c.categoryName}>
                  <b>{c.categoryName}</b>
                  <span>{c.grossTotal} {report.totals.currency}</span>
                </div>
              ))}
            </div>
          </Panel>
        </>
      )}
    </OfficeData>
  );
}
