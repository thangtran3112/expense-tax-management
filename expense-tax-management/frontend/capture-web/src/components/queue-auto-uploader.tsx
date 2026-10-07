"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";
import { useEffect } from "react";

import { listQueue } from "@/lib/queue";
import { readSession } from "@/lib/session";
import { processQueuedItems } from "@/lib/upload-processor";

/**
 * Web session wiring design (2026-10-06) -- mounted once in the Capture
 * shell. Processes the existing queue when the app loads (including
 * receipts queued before this release) and again whenever the browser
 * comes back online. Renders nothing.
 */
export function QueueAutoUploader() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();

  useEffect(() => {
    function run() {
      void listQueue().then((items) =>
        processQueuedItems(items, readSession(), getToken, organization?.id),
      );
    }
    run();
    window.addEventListener("online", run);
    return () => window.removeEventListener("online", run);
  }, [getToken, organization?.id]);

  return null;
}
