"use client";

import { useEffect, useState } from "react";
import {
  setAnalyticsConsent,
  getAnalyticsConsent,
} from "@/components/analytics-consent";

type ConsentState = "accepted" | "declined" | "unset";

export function ConsentControls() {
  const [consent, setConsent] = useState<ConsentState>("unset");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    setConsent(getAnalyticsConsent());
    const onChange = () => setConsent(getAnalyticsConsent());
    window.addEventListener("finlynq:analytics-consent", onChange);
    return () => {
      window.removeEventListener("finlynq:analytics-consent", onChange);
    };
  }, []);

  if (!hydrated) {
    return (
      <div className="my-4 rounded-lg border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="my-4 rounded-lg border border-border bg-card p-4">
      <p className="text-sm mb-3">
        Current choice:{" "}
        <strong>
          {consent === "accepted"
            ? "Accepted"
            : consent === "declined"
              ? "Declined"
              : "Not yet decided"}
        </strong>
      </p>
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setAnalyticsConsent("accepted")}
          className="px-3 py-1.5 rounded-md border border-border text-sm hover:bg-muted"
        >
          Accept analytics
        </button>
        <button
          type="button"
          onClick={() => setAnalyticsConsent("declined")}
          className="px-3 py-1.5 rounded-md border border-border text-sm hover:bg-muted"
        >
          Decline analytics
        </button>
      </div>
    </div>
  );
}
