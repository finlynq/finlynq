"use client";

import { useEffect, useState } from "react";
import { UnlockScreen } from "./unlock-screen";
import { SetupWizard } from "./setup-wizard";

type AuthState = "loading" | "needs-setup" | "locked" | "unlocked";

export function UnlockGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");
  const [hasExistingData, setHasExistingData] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const res = await fetch("/api/auth/unlock");
      const data = await res.json();

      if (data.unlocked) {
        setState("unlocked");
      } else if (data.needsSetup) {
        setHasExistingData(data.hasExistingData);
        setState("needs-setup");
      } else {
        setState("locked");
      }
    } catch {
      setState("locked");
    }
  }

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
      </div>
    );
  }

  if (state === "needs-setup") {
    return (
      <SetupWizard
        hasExistingData={hasExistingData}
        onComplete={() => setState("unlocked")}
      />
    );
  }

  if (state === "locked") {
    return <UnlockScreen onUnlocked={() => setState("unlocked")} />;
  }

  return <>{children}</>;
}
