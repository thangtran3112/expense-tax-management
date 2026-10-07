import type { ReactNode } from "react";

import { CaptureShell } from "@/components/capture-shell";
import { CaptureAuthGate } from "@/components/capture-auth-gate";
import { OfflineIndicator } from "@/components/offline-indicator";
import { QueueAutoUploader } from "@/components/queue-auto-uploader";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <CaptureAuthGate>
      <CaptureShell>
        <OfflineIndicator />
        <QueueAutoUploader />
        {children}
      </CaptureShell>
    </CaptureAuthGate>
  );
}
