"use client";
import { Download, FileCheck2 } from "lucide-react";
import { useState } from "react";
import { PageHead, Panel, Status } from "@/components/ui";
import { PersonalScopeUnavailable } from "@/components/scope-unavailable";
import { readOfficeSession } from "@/lib/session";

export default function Exports() {
  const session = readOfficeSession();
  const [creating, setCreating] = useState(false);

  if (!session || session.scope.kind !== "business") {
    return <PersonalScopeUnavailable feature="Exports" />;
  }

  return (
    <>
      <PageHead eyebrow="Canonical bundles" title="Snapshots that never move." />
      <Panel title="Create 2025 export">
        <p>Reviewed + excluded states · USD totals · foreign rows marked, never converted.</p>
        <button
          type="button"
          className="primary"
          disabled={creating}
          onClick={() => { setCreating(true); setTimeout(() => setCreating(false), 700); }}
          aria-busy={creating}
        >
          <FileCheck2 size={18} />
          {creating ? "Building checksums..." : "Create reviewed bundle"}
        </button>
      </Panel>
      <Panel title="Immutable history">
        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Taxonomy</th>
              <th>Rows</th>
              <th>State</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>09 Sep 2026</td>
              <td>Schedule C 2025</td>
              <td>143</td>
              <td><Status>Checksum verified</Status></td>
              <td><button type="button" aria-label="Download bundle"><Download size={17} /></button></td>
            </tr>
          </tbody>
        </table>
      </Panel>
    </>
  );
}
