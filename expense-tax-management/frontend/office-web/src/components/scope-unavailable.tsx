import { PageHead, Panel } from "@/components/ui";

/**
 * Shared component for Business-only pages rendered under Personal scope
 * or null/corrupt session. Renders an explicit accessible unavailable state.
 * Never constructs a Business URL or renders Business-scope content.
 */
export function PersonalScopeUnavailable({ feature }: { feature: string }) {
  return (
    <main>
      <PageHead eyebrow="Unavailable" title={feature} />
      <Panel title={`${feature} requires Business scope`}>
        <div className="empty" role="status" aria-label={`${feature} unavailable in Personal scope`}>
          <p>This feature is only available in Business scope.</p>
          <p>Switch to a Business scope to access {feature.toLowerCase()}.</p>
        </div>
      </Panel>
    </main>
  );
}
