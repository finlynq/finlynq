"use client";

import { useEffect, useState } from "react";
import { OnboardingWizard } from "./onboarding-wizard";

interface SessionData {
  authenticated: boolean;
  userId: string | null;
  onboardingComplete: boolean;
}

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionData | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data: SessionData) => {
        setSession(data);
        if (data.authenticated && data.onboardingComplete === false) {
          setShowWizard(true);
        }
      })
      .catch(() => {
        // Non-fatal — just don't show the wizard
      });
  }, []);

  return (
    <>
      {showWizard && session?.authenticated && (
        <OnboardingWizard
          userEmail=""
          onComplete={() => setShowWizard(false)}
        />
      )}
      {children}
    </>
  );
}
