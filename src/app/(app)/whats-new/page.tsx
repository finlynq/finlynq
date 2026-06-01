"use client";

/**
 * /whats-new — the notification center: all active announcements for the user.
 * Items unread on load are marked read (POST /api/announcements/[id]/read);
 * a "New" badge reflects the pre-load read state so the user can see what's
 * fresh on this visit.
 */

import { useEffect, useState } from "react";
import { Megaphone, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Announcement } from "@shared/types";

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function WhatsNewPage() {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/announcements")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.json();
      })
      .then((list: Announcement[]) => {
        if (cancelled) return;
        const safe = Array.isArray(list) ? list : [];
        setItems(safe);
        // Mark everything unread on this visit as read (fire-and-forget).
        for (const a of safe) {
          if (!a.read) {
            fetch(`/api/announcements/${a.id}/read`, { method: "POST" }).catch(() => {});
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load announcements.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">What&apos;s New</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Product news, updates, and announcements.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {items && items.length === 0 && !error && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No announcements yet. Check back soon.
        </Card>
      )}

      <div className="space-y-3">
        {items?.map((a) => {
          const warning = a.severity === "warning";
          return (
            <Card key={a.id} className="p-4">
              <div className="flex items-start gap-3">
                {warning ? (
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                ) : (
                  <Megaphone className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{a.title}</span>
                    {!a.read && (
                      <Badge className="bg-primary/15 text-primary">New</Badge>
                    )}
                    <Badge variant="outline" className="capitalize">
                      {a.category}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {fmtDate(a.publishedAt ?? a.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {a.body}
                  </p>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
