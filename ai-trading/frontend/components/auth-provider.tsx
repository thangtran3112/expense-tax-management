"use client";

import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";
import { requireClerkPublishableKey } from "@/lib/auth";

export function AuthProvider({ children }: { children: ReactNode }) {
  const publishableKey = requireClerkPublishableKey(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  return <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>;
}
