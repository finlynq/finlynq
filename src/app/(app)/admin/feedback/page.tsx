"use client";

/**
 * /admin/feedback — review queue for user-submitted feedback. Filter by status,
 * change status inline, attach an admin note. Gated server-side by requireAdmin.
 */

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MessageCircle } from "lucide-react";

interface FeedbackRow {
  id: number;
  userId: string;
  type: string;
  message: string;
  pageUrl: string | null;
  appVersion: string | null;
  status: string;
  adminNote: string | null;
  createdAt: string;
  username: string | null;
  email: string | null;
}

const FILTERS = ["all", "new", "triaged", "resolved"] as const;
type Filter = (typeof FILTERS)[number];
const STATUSES = ["new", "triaged", "resolved"];

const typeColor: Record<string, string> = {
  bug: "bg-destructive/15 text-destructive",
  idea: "bg-primary/15 text-primary",
  question: "bg-blue-500/15 text-blue-500",
  other: "bg-muted text-muted-foreground",
};

export default function AdminFeedbackPage() {
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = filter === "all" ? "" : `?status=${filter}`;
      const res = await fetch(`/api/admin/feedback${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setRows(data.feedback);
      const seed: Record<number, string> = {};
      for (const r of data.feedback as FeedbackRow[]) seed[r.id] = r.adminNote ?? "";
      setNotes(seed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (id: number, body: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/feedback/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) load();
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-2">
        <MessageCircle className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm capitalize transition-colors",
              filter === f
                ? "border-primary bg-primary/10 text-primary"
                : "border-border hover:bg-muted",
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
      {rows && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No feedback in this view.</p>
      )}

      <div className="space-y-3">
        {rows?.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={typeColor[r.type] ?? typeColor.other}>{r.type}</Badge>
              <Badge variant="outline" className="capitalize">
                {r.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {r.username || r.email || r.userId}
              </span>
              <span className="text-xs text-muted-foreground">
                · {new Date(r.createdAt).toLocaleString()}
              </span>
              {r.appVersion && r.appVersion !== "web" && (
                <span className="text-xs text-muted-foreground">· {r.appVersion}</span>
              )}
            </div>

            <p className="mt-2 whitespace-pre-wrap text-sm">{r.message}</p>

            {r.pageUrl && (
              <p className="mt-1 text-xs text-muted-foreground">Page: {r.pageUrl}</p>
            )}

            <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border/50 pt-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Status</span>
                <select
                  value={r.status}
                  onChange={(e) => patch(r.id, { status: e.target.value })}
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-1 items-end gap-2">
                <input
                  value={notes[r.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                  placeholder="Admin note…"
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => patch(r.id, { adminNote: notes[r.id] ?? "" })}
                >
                  Save note
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
