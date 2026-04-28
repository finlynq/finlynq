"use client";

/**
 * /admin/inbox — admin triage for non-import emails.
 *
 * Two tabs:
 *   - Mailbox: info@/admin@/etc. and named-human matches, kept indefinitely
 *   - Trash:   unknown addresses, auto-deleted after 24h
 *
 * SECURITY: email body HTML is attacker-controlled. Render it in a sandboxed
 * iframe with `srcDoc` + `sandbox="allow-same-origin"` (no allow-scripts, no
 * allow-forms, no top-navigation). Do NOT dangerouslySetInnerHTML the html
 * into the main DOM.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Inbox, Trash2, RefreshCw, ArrowUpFromLine, CheckCircle2 } from "lucide-react";

interface InboxRow {
  id: string;
  category: "mailbox" | "trash";
  toAddress: string;
  fromAddress: string;
  subject: string | null;
  bodyText: string | null;
  attachmentCount: number;
  receivedAt: string;
  expiresAt: string | null;
  triagedAt: string | null;
}

interface InboxDetail extends InboxRow {
  bodyHtml: string | null;
  svixId: string | null;
}

function hoursUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (60 * 60 * 1000)));
}

export default function AdminInboxPage() {
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<"mailbox" | "trash">("mailbox");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/inbox?category=${category}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setOpenId(id);
    setDetail(null);
    try {
      const res = await fetch(`/api/admin/inbox/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setOpenId(null);
    }
  }, []);

  const closeDetail = () => { setOpenId(null); setDetail(null); };

  const markTriaged = useCallback(async (id: string) => {
    setActing(true);
    try {
      await fetch(`/api/admin/inbox/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "triage" }),
      });
      closeDetail();
      load();
    } finally { setActing(false); }
  }, [load]);

  const promote = useCallback(async (id: string) => {
    setActing(true);
    try {
      await fetch(`/api/admin/inbox/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote-to-mailbox" }),
      });
      closeDetail();
      load();
    } finally { setActing(false); }
  }, [load]);

  const remove = useCallback(async (id: string) => {
    if (!confirm("Delete this email permanently?")) return;
    setActing(true);
    try {
      await fetch(`/api/admin/inbox/${id}`, { method: "DELETE" });
      closeDetail();
      load();
    } finally { setActing(false); }
  }, [load]);

  const srcDoc = useMemo(() => {
    if (!detail?.bodyHtml) return null;
    // Wrap the untrusted HTML in a minimal document. The iframe's `sandbox`
    // attribute strips scripts + forms + top-nav; `allow-same-origin` lets
    // srcDoc resolve relative URLs to about:blank (harmless). No CSP meta
    // needed because sandbox already blocks script execution.
    return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font:13px -apple-system,sans-serif;margin:12px">${detail.bodyHtml}</body></html>`;
  }, [detail]);

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Admin Inbox</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Non-import email routed to this app. Mailbox is kept indefinitely; trash auto-deletes after 24 hours.
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

      <Tabs value={category} onValueChange={(v) => setCategory(v as "mailbox" | "trash")}>
        <TabsList>
          <TabsTrigger value="mailbox"><Inbox className="h-4 w-4 mr-1.5" />Mailbox</TabsTrigger>
          <TabsTrigger value="trash"><Trash2 className="h-4 w-4 mr-1.5" />Trash</TabsTrigger>
        </TabsList>

        <TabsContent value={category} className="mt-4">
          <Card>
            <CardContent className="p-0">
              {loading && !rows && <p className="p-6 text-sm text-muted-foreground text-center">Loading…</p>}
              {rows && rows.length === 0 && (
                <p className="p-8 text-sm text-muted-foreground text-center">No {category} messages.</p>
              )}
              {rows && rows.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>From → To</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead className="w-20">Atts</TableHead>
                      <TableHead>Received</TableHead>
                      {category === "trash" && <TableHead>Expires</TableHead>}
                      <TableHead className="w-24">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => openDetail(r.id)}>
                        <TableCell className="text-xs">
                          <div className="font-mono">{r.fromAddress}</div>
                          <div className="text-muted-foreground">→ {r.toAddress}</div>
                        </TableCell>
                        <TableCell className="text-xs max-w-[280px] truncate">{r.subject || <span className="text-muted-foreground">(no subject)</span>}</TableCell>
                        <TableCell className="text-xs text-center font-mono">{r.attachmentCount || ""}</TableCell>
                        <TableCell className="text-xs">{new Date(r.receivedAt).toLocaleString()}</TableCell>
                        {category === "trash" && (
                          <TableCell className="text-xs">
                            {r.expiresAt ? `${hoursUntil(r.expiresAt)}h` : "—"}
                          </TableCell>
                        )}
                        <TableCell>
                          {r.triagedAt ? (
                            <Badge variant="outline" className="text-[10px]"><CheckCircle2 className="h-3 w-3 mr-1" />triaged</Badge>
                          ) : (
                            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-[10px]">new</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Detail panel — bottom sheet style. Kept inline (no Dialog) so the
          sandboxed iframe for body HTML can take full width and doesn't have
          to fight a modal's focus trap. */}
      {openId && (
        <Card className="mt-4">
          <CardContent className="py-4 space-y-3">
            {!detail && <p className="text-sm text-muted-foreground">Loading…</p>}
            {detail && (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{detail.subject || "(no subject)"}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {detail.fromAddress} → {detail.toAddress}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      received {new Date(detail.receivedAt).toLocaleString()}
                      {detail.attachmentCount > 0 && ` · ${detail.attachmentCount} attachment${detail.attachmentCount === 1 ? "" : "s"}`}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={closeDetail}>Close</Button>
                </div>

                <div className="border rounded-lg overflow-hidden bg-background">
                  {srcDoc ? (
                    <iframe
                      title="Email body"
                      sandbox="allow-same-origin"
                      srcDoc={srcDoc}
                      className="w-full h-[400px] bg-white"
                    />
                  ) : detail.bodyText ? (
                    <pre className="p-3 text-xs whitespace-pre-wrap max-h-[400px] overflow-auto font-mono">{detail.bodyText}</pre>
                  ) : (
                    <p className="p-6 text-sm text-muted-foreground text-center">(no body content)</p>
                  )}
                </div>

                <div className="flex items-center gap-2 pt-1">
                  {!detail.triagedAt && (
                    <Button variant="outline" size="sm" onClick={() => markTriaged(detail.id)} disabled={acting}>
                      <CheckCircle2 className="h-4 w-4 mr-1.5" />Mark triaged
                    </Button>
                  )}
                  {detail.category === "trash" && (
                    <Button variant="outline" size="sm" onClick={() => promote(detail.id)} disabled={acting}>
                      <ArrowUpFromLine className="h-4 w-4 mr-1.5" />Promote to mailbox
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(detail.id)}
                    disabled={acting}
                    className="text-rose-700 hover:text-rose-800 hover:bg-rose-50 ml-auto"
                  >
                    <Trash2 className="h-4 w-4 mr-1.5" />Delete
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
