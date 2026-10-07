"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";
import { Camera, FileUp, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { enqueue } from "@/lib/queue";
import { readSession } from "@/lib/session";
import { processQueueItem } from "@/lib/upload-processor";

const accepted = "image/jpeg,image/png,image/webp,application/pdf";

export default function CapturePage() {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [mode, setMode] = useState<"ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate">("ocr_mode_balanced");
  const [error, setError] = useState<string | null>(null);

  async function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!accepted.includes(file.type) || file.size > 25 * 1024 * 1024) {
      setError("Use JPEG, PNG, WebP, or PDF up to 25MB.");
      return;
    }
    const item = await enqueue(file, mode);
    router.push("/queue");
    // Web session wiring design (2026-10-06): upload right after capture
    // when online. The Queue page's own load effect still picks it up if
    // this upload is skipped (offline) or fails.
    const session = readSession();
    if (session) void processQueueItem(session, item, getToken, organization?.id);
  }

  return <>
    <header className="page-head"><div><p className="kicker">Tran Studio · Owner</p><h1>Catch the receipt.<br />Keep moving.</h1><p>Capture now. Review when you have a moment.</p></div><span className="allowance">18 / 20<small>UTC reset</small></span></header>
    {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError(null)}>Dismiss</button></div>}
    <section className="capture-grid">
      <article className="camera-card"><div className="viewfinder"><Camera size={38} aria-hidden="true" /><span>Align receipt edges</span></div><div className="actions"><button className="primary" onClick={() => input.current?.click()}><Camera size={20} />Capture receipt</button><button onClick={() => input.current?.click()}><FileUp size={20} />Choose file</button></div><input ref={input} hidden type="file" accept={accepted} capture="environment" onChange={(event) => void pick(event.target.files)} /></article>
      <article className="mode-card"><h2>Extraction mode</h2><fieldset><legend>Choose OCR quality</legend>{[
        ["ocr_mode_fast", "Fast", "Low latency"],
        ["ocr_mode_balanced", "Balanced", "Recommended"],
        ["ocr_mode_accurate", "Accurate", "Plan gated"],
      ].map(([value,label,note]) => <label key={value} className={mode === value ? "selected" : ""}><input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value as typeof mode)} /><span><b>{label}</b><small>{note}</small></span></label>)}</fieldset><p className="trust"><ShieldCheck size={17} /> Files upload directly through expiring signed URLs.</p></article>
    </section>
  </>;
}
