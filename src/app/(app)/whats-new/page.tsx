"use client";

/**
 * /whats-new — the notification center: all active announcements for the user.
 * Items unread on load are marked read (POST /api/announcements/[id]/read);
 * a "New" badge reflects the pre-load read state so the user can see what's
 * fresh on this visit.
 *
 * On a self-hosted install it also lists Finlynq's release notes under the
 * announcements (GH #471): which version this server runs, a newer release on
 * GitHub when there is one, and the notes from the build. Finlynq's hosted
 * service gets `{ selfHosted: false }` from the route and shows announcements
 * only.
 */

import { useEffect, useState } from "react";
import { Megaphone, AlertTriangle, Rocket, ExternalLink } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Announcement } from "@shared/types";
import { SEEN_RELEASE_KEY, type LatestRelease, type WhatsNewRelease } from "@/lib/releases/whats-new";

type ReleasesResponse =
  | { selfHosted: false }
  | { selfHosted: true; running: string | null; releases: WhatsNewRelease[]; latest: LatestRelease | null; updateCheck: "on" | "off" };

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  // A bare YYYY-MM-DD is a calendar date: read it as local noon so no time zone shifts the day.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function WhatsNewPage() {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [releases, setReleases] = useState<ReleasesResponse | null>(null);
  // The running release shows "New" until this browser has seen it once.
  const [unseenRelease, setUnseenRelease] = useState<string | null>(null);

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
    // Release notes: a failure just means no Releases section.
    fetch("/api/whats-new/releases")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { data?: ReleasesResponse } | null) => {
        if (cancelled || !body?.data) return;
        const data = body.data;
        setReleases(data);
        if (data.selfHosted && data.running) {
          try {
            if (localStorage.getItem(SEEN_RELEASE_KEY) !== data.running) {
              setUnseenRelease(data.running);
              localStorage.setItem(SEEN_RELEASE_KEY, data.running);
            }
          } catch {
            /* storage blocked: no New badge */
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const self = releases?.selfHosted ? releases : null;
  // On a self-hosted install with release notes, an empty announcements list
  // is not worth a "No announcements yet" card.
  const showEmpty = items && items.length === 0 && !error && !(self && self.releases.length > 0);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">What&apos;s New</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Product news, updates, and announcements.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {showEmpty && (
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

      {self && self.releases.length > 0 && (
        <section className="mt-8 space-y-3" aria-labelledby="releases-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="releases-heading" className="text-lg font-semibold tracking-tight">Releases</h2>
            {self.running && <span className="text-sm text-muted-foreground">You&apos;re on v{self.running}</span>}
          </div>

          {self.latest && (
            <Card className="border-primary/40 bg-primary/5 p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <Rocket className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="flex-1">
                  <span className="font-medium">v{self.latest.version} is available</span>
                  {self.latest.publishedAt ? ` (released ${fmtDate(self.latest.publishedAt)})` : ""}. Update with{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">docker compose pull</code> and restart.
                </span>
                <a href={self.latest.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs underline">
                  What&apos;s in it <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </div>
            </Card>
          )}

          {self.releases.map((r) => {
            const running = r.version === self.running;
            return (
              <Card key={r.slug} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{r.name}</span>
                  {running && <Badge variant="outline">Running</Badge>}
                  {running && unseenRelease === r.version && <Badge className="bg-primary/15 text-primary">New</Badge>}
                  <span className="text-xs text-muted-foreground">{fmtDate(r.date)}</span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{r.tagline}</p>
                <details className="mt-2 text-sm" open={running}>
                  <summary className="cursor-pointer text-xs font-medium text-primary">Highlights</summary>
                  <div className="mt-2 space-y-3">
                    {r.sections.map((s) => (
                      <div key={s.heading}>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.heading}</p>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                          {s.items.map((item, i) => (
                            <li key={i}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </details>
                <a href={r.githubUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs underline">
                  Release on GitHub <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              </Card>
            );
          })}

          {self.updateCheck === "off" && (
            <p className="text-xs text-muted-foreground">Checking GitHub for newer releases is turned off on this server (PF_UPDATE_CHECK).</p>
          )}
        </section>
      )}
    </div>
  );
}
