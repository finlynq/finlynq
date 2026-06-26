"use client";

/**
 * /admin/feedback — review queue for user-submitted feedback. Filter by status,
 * change status inline, attach a PRIVATE admin note, and reply to the user via
 * the thread dialog (the reply IS visible to the user; the note is not). Gated
 * server-side by requireAdmin.
 */

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { MessageCircle } from "lucide-react";
import type { FeedbackMessage, FeedbackThread } from "@shared/types";

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
  replyCount: number;
  adminUnread: boolean;
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

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function Bubble({
  side,
  label,
  at,
  body,
}: {
  side: "left" | "right";
  label: string;
  at: string;
  body: string;
}) {
  return (
    <div className={cn("flex flex-col", side === "right" ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
          side === "right" ? "bg-primary/10 text-foreground" : "bg-muted text-foreground",
        )}
      >
        {body}
      </div>
      <span className="mt-1 text-[10px] text-muted-foreground">
        {label} · {fmt(at)}
      </span>
    </div>
  );
}

function AdminThreadDialog({
  feedbackId,
  onClose,
  onChanged,
}: {
  feedbackId: number | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [thread, setThread] = useState<FeedbackThread | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (feedbackId == null) {
      setThread(null);
      setReply("");
      setError(null);
      return;
    }
    let cancelled = false;
    setThread(null);
    setError(null);
    fetch(`/api/admin/feedback/${feedbackId}`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.json();
      })
      .then((t: FeedbackThread) => {
        if (!cancelled) setThread(t);
        // GET marked admin-read server-side — refresh the list dot.
        onChanged();
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load this thread.");
      });
    return () => {
      cancelled = true;
    };
    // onChanged is stable enough (parent useCallback); intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedbackId]);

  const send = async () => {
    const body = reply.trim();
    if (!body || feedbackId == null) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/feedback/${feedbackId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || "Failed to send reply.");
      }
      const msg: FeedbackMessage = await res.json();
      setThread((t) =>
        t
          ? {
              ...t,
              messages: [...t.messages, msg],
              messageCount: t.messageCount + 1,
              status: t.status === "new" ? "triaged" : t.status,
            }
          : t,
      );
      setReply("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send reply.");
    } finally {
      setSending(false);
    }
  };

  const who = thread ? thread.username || thread.email || "user" : "";

  return (
    <Dialog open={feedbackId != null} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="capitalize">
            {thread ? `${thread.type} feedback` : "Feedback"}
          </DialogTitle>
          <DialogDescription>
            {thread ? `From ${who}. ` : ""}Your reply is visible to the user.
          </DialogDescription>
        </DialogHeader>

        {error && !thread && <p className="text-sm text-destructive">{error}</p>}

        {thread && (
          <>
            <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
              <Bubble side="left" label={who} at={thread.createdAt} body={thread.seed} />
              {thread.attachment && feedbackId != null && (
                <div className="flex flex-col items-start">
                  <a
                    href={`/api/admin/feedback/${feedbackId}/attachment`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block max-w-[85%] overflow-hidden rounded-lg border border-border"
                    title={thread.attachment.filename ?? "attachment"}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/admin/feedback/${feedbackId}/attachment`}
                      alt={thread.attachment.filename ?? "feedback attachment"}
                      className="max-h-64 w-auto object-contain"
                    />
                  </a>
                  <a
                    href={`/api/admin/feedback/${feedbackId}/attachment`}
                    target="_blank"
                    rel="noopener noreferrer"
                    download={thread.attachment.filename ?? undefined}
                    className="mt-1 text-[10px] text-primary underline-offset-2 hover:underline"
                  >
                    {thread.attachment.filename ?? "Download attachment"}
                  </a>
                </div>
              )}
              {thread.messages.map((m) => (
                <Bubble
                  key={m.id}
                  side={m.authorRole === "admin" ? "right" : "left"}
                  label={m.authorRole === "admin" ? "You" : who}
                  at={m.createdAt}
                  body={m.body}
                />
              ))}
            </div>
            <div className="space-y-2">
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder="Reply to the user…"
                className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end">
                <Button onClick={send} disabled={sending || !reply.trim()}>
                  {sending ? "Sending…" : "Send reply"}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function AdminFeedbackPage() {
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [openId, setOpenId] = useState<number | null>(null);

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
              {r.adminUnread && (
                <span
                  className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary"
                  title="New reply from the user"
                >
                  <span className="h-2 w-2 rounded-full bg-primary" />
                  New reply
                </span>
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
              <Button variant="outline" size="sm" onClick={() => setOpenId(r.id)}>
                {r.replyCount > 0
                  ? `View thread (${r.replyCount})`
                  : "Reply to user"}
              </Button>
            </div>

            <div className="mt-3 flex items-end gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-muted-foreground">
                  Admin note (private — not shown to the user)
                </label>
                <input
                  value={notes[r.id] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                  placeholder="Admin note…"
                  className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => patch(r.id, { adminNote: notes[r.id] ?? "" })}
              >
                Save note
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <AdminThreadDialog
        feedbackId={openId}
        onClose={() => {
          setOpenId(null);
          load();
        }}
        onChanged={load}
      />
    </div>
  );
}
