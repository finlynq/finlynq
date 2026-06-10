"use client";

/**
 * /admin/email-inbox — cross-user operator oversight of inbound email-import
 * rows (FINLYNQ-121). The cross-user counterpart to the per-user Email tab
 * (`/import?tab=email`) and a sibling of `/admin/inbox` (incoming_emails).
 * Gated server-side by requireAdmin + managed-mode.
 *
 * METADATA-FIRST by design: from/subject preview is shown ONLY for service-tier
 * rows (operator-decryptable); user-tier rows render a "🔒 user-encrypted"
 * placeholder because an admin cannot decrypt user-DEK content. The per-user
 * panel surfaces the needs_review backlog + unparseable rate across all users.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Mailbox, RefreshCw, Lock, Users } from "lucide-react";

interface ByUser {
  userId: string;
  username: string | null;
  email: string | null;
  total: number;
  needsReview: number;
  unparseable: number;
  unparseableRate: number;
}

interface InboxRow {
  id: string;
  userId: string;
  username: string | null;
  email: string | null;
  encryptionTier: string | null;
  fromAddress: string | null;
  subject: string | null;
  redacted: boolean;
  action: string;
  sourceKind: string;
  parseConfidence: string | null;
  receivedAt: string;
  messageId: string | null;
  matchedRuleId: number | null;
  recordedTransactionId: number | null;
}

interface ApiResponse {
  rows: InboxRow[];
  byUser: ByUser[];
  total: number;
  limit: number;
  offset: number;
}

const ACTIONS = [
  "all",
  "needs_review",
  "unparseable",
  "auto_recorded",
  "manually_recorded",
  "duplicate_skipped",
  "discarded",
  "pending",
] as const;
type ActionFilter = (typeof ACTIONS)[number];

const SOURCE_KINDS = ["all", "body", "attachment"] as const;
type SourceFilter = (typeof SOURCE_KINDS)[number];

const actionColor: Record<string, string> = {
  needs_review: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  unparseable: "bg-destructive/15 text-destructive",
  auto_recorded: "bg-emerald-500/15 text-emerald-600",
  manually_recorded: "bg-emerald-500/15 text-emerald-600",
  duplicate_skipped: "bg-muted text-muted-foreground",
  discarded: "bg-muted text-muted-foreground",
  pending: "bg-blue-500/15 text-blue-500",
};

function who(u: { username: string | null; email: string | null; userId: string }): string {
  return u.username || u.email || u.userId;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export default function AdminEmailInboxPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionFilter>("all");
  const [sourceKind, setSourceKind] = useState<SourceFilter>("all");
  const [userId, setUserId] = useState<string>("");
  const [since, setSince] = useState<string>("");
  const [until, setUntil] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (action !== "all") p.set("action", action);
      if (sourceKind !== "all") p.set("sourceKind", sourceKind);
      if (userId) p.set("userId", userId);
      if (since) p.set("since", since);
      if (until) p.set("until", until);
      const qs = p.toString();
      const res = await fetch(`/api/admin/email-inbox${qs ? `?${qs}` : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [action, sourceKind, userId, since, until]);

  useEffect(() => {
    load();
  }, [load]);

  const selectedUserLabel = useMemo(() => {
    if (!userId || !data) return null;
    const u = data.byUser.find((g) => g.userId === userId);
    return u ? who(u) : userId;
  }, [userId, data]);

  return (
    <div className="max-w-7xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Mailbox className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">Imported Email Oversight</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Cross-user view of inbound email-import rows. Metadata is always
            shown; from/subject preview is available only for service-tier rows
            (before the owner&apos;s next login). User-tier content is encrypted
            with the owner&apos;s key and cannot be read here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-rose-200 bg-rose-50/30">
          <CardContent className="py-3 text-sm text-rose-700">{error}</CardContent>
        </Card>
      )}

      {/* ─── Per-user grouped counts ──────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center gap-2 px-6 py-4 border-b">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold">By user</h2>
            <span className="text-xs text-muted-foreground">
              Counts honor the action / source / date filters (not the selected user).
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Needs review</TableHead>
                <TableHead className="text-right">Unparseable</TableHead>
                <TableHead className="text-right">Unparseable rate</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.byUser.map((g) => (
                <TableRow key={g.userId} className={userId === g.userId ? "bg-primary/5" : ""}>
                  <TableCell className="text-sm font-medium">{who(g)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{g.total}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {g.needsReview > 0 ? (
                      <span className="text-amber-600">{g.needsReview}</span>
                    ) : (
                      g.needsReview
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {g.unparseable > 0 ? (
                      <span className="text-destructive">{g.unparseable}</span>
                    ) : (
                      g.unparseable
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-muted-foreground">
                    {(g.unparseableRate * 100).toFixed(0)}%
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={() => setUserId(userId === g.userId ? "" : g.userId)}
                    >
                      {userId === g.userId ? "Clear" : "Filter"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {data && data.byUser.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    No email-import rows match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ─── Filters ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-wrap gap-1.5">
          {ACTIONS.map((a) => (
            <button
              key={a}
              onClick={() => setAction(a)}
              className={`rounded-md border px-2.5 py-1 text-xs capitalize transition-colors ${
                action === a
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border hover:bg-muted"
              }`}
            >
              {a.replace(/_/g, " ")}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {SOURCE_KINDS.map((s) => (
            <button
              key={s}
              onClick={() => setSourceKind(s)}
              className={`rounded-md border px-2.5 py-1 text-xs capitalize transition-colors ${
                sourceKind === s
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border hover:bg-muted"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          From
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          To
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        {selectedUserLabel && (
          <Badge variant="outline" className="gap-1">
            user: {selectedUserLabel}
            <button className="ml-1 text-muted-foreground hover:text-foreground" onClick={() => setUserId("")}>
              ×
            </button>
          </Badge>
        )}
      </div>

      {/* ─── Rows ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          {loading && !data && (
            <p className="p-6 text-sm text-muted-foreground text-center">Loading…</p>
          )}
          {data && data.rows.length === 0 && (
            <p className="p-8 text-sm text-muted-foreground text-center">No rows match these filters.</p>
          )}
          {data && data.rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>From / Subject</TableHead>
                  <TableHead className="w-28">Action</TableHead>
                  <TableHead className="w-20">Source</TableHead>
                  <TableHead className="w-24">Confidence</TableHead>
                  <TableHead className="w-20">Tier</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead className="w-20">Rule</TableHead>
                  <TableHead className="w-16">Txn</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">{who(r)}</TableCell>
                    <TableCell className="text-xs max-w-[320px]">
                      {r.redacted ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Lock className="h-3 w-3" /> user-encrypted
                        </span>
                      ) : r.fromAddress || r.subject ? (
                        <>
                          <div className="font-mono truncate">{r.fromAddress || "—"}</div>
                          <div className="text-muted-foreground truncate">
                            {r.subject || <span className="italic">(no subject)</span>}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${actionColor[r.action] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {r.action.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{r.sourceKind}</TableCell>
                    <TableCell className="text-xs">
                      {r.parseConfidence ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="text-[10px]">
                        {r.encryptionTier ?? "service"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{fmt(r.receivedAt)}</TableCell>
                    <TableCell className="text-xs font-mono">
                      {r.matchedRuleId ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-xs font-mono">
                      {r.recordedTransactionId ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
