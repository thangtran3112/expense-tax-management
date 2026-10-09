"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useUser } from "@clerk/react";
import { ChevronDown, LogOut } from "lucide-react";
import { useTradingSignOut } from "@/components/auth-gate";

export function AccountMenu() {
  const { user } = useUser();
  const signOut = useTradingSignOut();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (!user) return null;
  const name = (user.fullName || user.firstName || "").trim() || "Signed-in user";
  const email = user.primaryEmailAddress?.emailAddress || "No email address";
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toUpperCase();

  return (
    <div className="relative" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Account"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 min-w-11 cursor-pointer items-center justify-center gap-2 rounded-md px-2 text-sm font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
      >
        <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold">{initials}</span>
        <span className="hidden md:inline">Account</span>
        <ChevronDown aria-hidden size={14} className="hidden md:block" />
      </button>
      {open && (
        <section
          id={panelId}
          ref={panelRef}
          aria-label="Signed-in account"
          className="absolute right-0 top-full z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-4 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Your profile</h2>
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">Read-only</span>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="text-xs text-muted-foreground">Name</dt><dd className="mt-1 break-words">{name}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="mt-1 break-all">{email}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">Account details are view-only.</p>
          <div className="mt-4 border-t border-border pt-3">
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-3 text-sm font-medium text-destructive transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              <LogOut aria-hidden size={16} />Sign out
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
