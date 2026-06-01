"use client";

/**
 * Floating banner for the newest unread *pinned* announcement. Driven by
 * GET /api/announcements (NOT localStorage — read state lives server-side in
 * announcement_reads so it's consistent across devices). Dismiss POSTs
 * /api/announcements/[id]/read. Styled like DonationBanner; positioned bottom-
 * left so it doesn't collide with the bottom-right donation card.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Megaphone, AlertTriangle, X } from "lucide-react";
import type { Announcement } from "@shared/types";

export function AnnouncementBanner() {
  const [item, setItem] = useState<Announcement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/announcements")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Announcement[]) => {
        if (cancelled || !Array.isArray(list)) return;
        // Newest unread pinned item drives the banner (API already sorts
        // pinned-first, then by publish/created date).
        const next = list.find((a) => a.pinned && !a.read) ?? null;
        setItem(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    if (!item) return;
    const id = item.id;
    setItem(null);
    fetch(`/api/announcements/${id}/read`, { method: "POST" }).catch(() => {});
  };

  if (!item) return null;

  const warning = item.severity === "warning";

  return (
    <div className="fixed bottom-4 left-4 z-50 max-w-sm rounded-xl border border-border/50 bg-card p-4 shadow-lg">
      <div className="flex items-start gap-3">
        {warning ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        ) : (
          <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        )}
        <div className="flex-1 text-sm">
          <p className="font-medium text-foreground">{item.title}</p>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground">
            {item.body}
          </p>
          <div className="mt-3 flex gap-2">
            <Link
              href="/whats-new"
              onClick={dismiss}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              What&apos;s new
            </Link>
            <button
              onClick={dismiss}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Dismiss
            </button>
          </div>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss announcement"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
