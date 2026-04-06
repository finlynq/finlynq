"use client";

/**
 * TrialBanner — shown to users on the "trial" plan.
 *
 * Fetches /api/billing/status on mount. If the user is on a trial,
 * shows a dismissible banner with days remaining and an upgrade CTA.
 * Automatically hidden for paid users, free users, and non-managed mode.
 */

import { useEffect, useState } from "react";
import { X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BillingStatus {
  plan: string;
  planExpiresAt: string | null;
}

function daysRemaining(expiresAt: string | null): number {
  if (!expiresAt) return 0;
  const diff = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export function TrialBanner() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  useEffect(() => {
    // Check session storage so the banner doesn't re-flash on every navigation
    const key = "pf-trial-banner-dismissed";
    if (sessionStorage.getItem(key)) {
      setDismissed(true);
      return;
    }

    fetch("/api/billing/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: BillingStatus | null) => {
        if (data?.plan === "trial") setStatus(data);
      })
      .catch(() => {});
  }, []);

  function handleDismiss() {
    sessionStorage.setItem("pf-trial-banner-dismissed", "1");
    setDismissed(true);
  }

  async function handleUpgrade() {
    setUpgrading(true);
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setUpgrading(false);
      }
    } catch {
      setUpgrading(false);
    }
  }

  if (dismissed || !status) return null;

  const days = daysRemaining(status.planExpiresAt);
  const urgent = days <= 3;

  return (
    <div
      className={`relative flex items-center justify-between gap-3 px-4 py-2.5 text-sm ${
        urgent
          ? "bg-rose-500/10 border-b border-rose-500/30 text-rose-300"
          : "bg-indigo-500/10 border-b border-indigo-500/20 text-indigo-300"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Zap className="size-4 shrink-0" />
        <span className="truncate">
          {days > 0 ? (
            <>
              Your free trial ends in{" "}
              <strong className="font-semibold">
                {days} {days === 1 ? "day" : "days"}
              </strong>
              . Upgrade to keep full access.
            </>
          ) : (
            <>Your free trial has expired. Upgrade to restore access.</>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          variant="outline"
          onClick={handleUpgrade}
          disabled={upgrading}
          className={`h-7 text-xs border-current ${
            urgent
              ? "text-rose-300 hover:bg-rose-500/20"
              : "text-indigo-300 hover:bg-indigo-500/20"
          }`}
        >
          {upgrading ? "Redirecting…" : "Upgrade now"}
        </Button>
        <button
          onClick={handleDismiss}
          className="rounded p-0.5 hover:bg-white/10 transition-colors"
          aria-label="Dismiss trial banner"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
