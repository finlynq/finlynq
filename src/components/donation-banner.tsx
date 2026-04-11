"use client";

import { useState, useEffect } from "react";
import { Heart, X } from "lucide-react";
import { DONATION_LINKS } from "@/lib/donations";

const STORAGE_KEY = "finlynq-donation-banner-dismissed";
const SHOW_AFTER_DAYS = 30;

export function DonationBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const dismissed = localStorage.getItem(STORAGE_KEY);
      if (dismissed) {
        const daysSince = (Date.now() - Number(dismissed)) / (1000 * 60 * 60 * 24);
        if (daysSince < SHOW_AFTER_DAYS) return;
      }
      const firstVisit = localStorage.getItem("finlynq-first-visit");
      if (!firstVisit) {
        localStorage.setItem("finlynq-first-visit", String(Date.now()));
        return;
      }
      const daysUsing = (Date.now() - Number(firstVisit)) / (1000 * 60 * 60 * 24);
      if (daysUsing >= SHOW_AFTER_DAYS) setVisible(true);
    } catch {
      // localStorage not available
    }
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch {}
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-border/50 bg-card p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <Heart className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
        <div className="flex-1 text-sm">
          <p className="font-medium text-foreground">Enjoying Finlynq?</p>
          <p className="mt-1 text-muted-foreground">
            It&apos;s free and open source, built in my spare time. If it&apos;s useful to you, consider supporting the project.
          </p>
          <div className="mt-3 flex gap-2">
            <a
              href={DONATION_LINKS.github}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              GitHub Sponsors
            </a>
            <a
              href={DONATION_LINKS.kofi}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Ko-fi
            </a>
          </div>
        </div>
        <button onClick={dismiss} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
