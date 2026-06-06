"use client";

/**
 * Email tab for /import (Epic C1) — account-agnostic.
 *
 * Lists the user's inbound emails (turned into transactions from a body parse
 * or an attachment), with an action badge each. Opening a row fetches the
 * decrypted body and renders it in a SANDBOXED iframe (no allow-scripts —
 * the body is attacker-controlled). `needs_review` body rows get an inline
 * account + category picker → Record / Discard. Every row can be deleted
 * (local + Mailpit DELETE).
 *
 * Loading the tab fires the DEK-bearing sweep server-side (the GET), so an
 * email that matches an auto-rule flips to "Recorded" on open.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, RefreshCw, Mail } from "lucide-react";
import { safeAccountName, safeName } from "@/lib/safe-name";
import { formatCurrency } from "@/lib/currency";

type Action =
  | "pending"
  | "auto_recorded"
  | "duplicate_skipped"
  | "needs_review"
  | "unparseable"
  | "discarded"
  | "manually_recorded";

interface EmailInboxItem {
  id: string;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string;
  action: Action;
  sourceKind: "attachment" | "body";
  parseConfidence: "high" | "low" | null;
  matchedRuleId: number | null;
  recordedTransactionId: number | null;
  stagedImportId: string | null;
  candidate: { date: string; amount: number; currency: string; payee: string } | null;
}

interface EmailInboxDetail {
  id: string;
  fromAddress: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: string;
  action: Action;
  sourceKind: "attachment" | "body";
}

interface AccountOpt {
  id: number;
  name: string | null;
  alias?: string | null;
  currency: string;
  isInvestment?: boolean;
  archived?: boolean;
}
interface CategoryOpt {
  id: number;
  name: string | null;
  type: string;
}

const BADGE: Record<Action, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-muted text-muted-foreground" },
  needs_review: { label: "Needs review", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200" },
  auto_recorded: { label: "Auto-recorded", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
  manually_recorded: { label: "Recorded", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
  duplicate_skipped: { label: "Duplicate", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  unparseable: { label: "Unparseable", cls: "bg-muted text-muted-foreground" },
  discarded: { label: "Discarded", cls: "bg-muted text-muted-foreground line-through" },
};

export function InboxEmailTab() {
  const [items, setItems] = useState<EmailInboxItem[]>([]);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [categories, setCategories] = useState<CategoryOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EmailInboxDetail | null>(null);
  const [acting, setActing] = useState(false);
  // Per-row record-picker selections.
  const [pickAccount, setPickAccount] = useState<number | null>(null);
  const [pickCategory, setPickCategory] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [emailsRes, acctRes, catRes] = await Promise.all([
        fetch("/api/import/email-inbox"),
        fetch("/api/accounts"),
        fetch("/api/categories"),
      ]);
      if (!emailsRes.ok) throw new Error(`emails: ${emailsRes.status}`);
      setItems(await emailsRes.json());
      if (acctRes.ok) setAccounts(await acctRes.json());
      if (catRes.ok) setCategories(await catRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openRow = useCallback(
    async (id: string) => {
      if (openId === id) {
        setOpenId(null);
        setDetail(null);
        return;
      }
      setOpenId(id);
      setDetail(null);
      setPickAccount(null);
      setPickCategory(null);
      try {
        const res = await fetch(`/api/import/email-inbox/${id}`);
        if (res.ok) setDetail(await res.json());
      } catch {
        /* ignore — body just won't render */
      }
    },
    [openId],
  );

  const record = useCallback(
    async (id: string) => {
      if (pickAccount == null || pickCategory == null) return;
      setActing(true);
      try {
        const res = await fetch(`/api/import/email-inbox/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "record",
            accountId: pickAccount,
            categoryId: pickCategory,
          }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.error ?? `HTTP ${res.status}`);
        }
        setOpenId(null);
        setDetail(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setActing(false);
      }
    },
    [pickAccount, pickCategory, load],
  );

  const discard = useCallback(
    async (id: string) => {
      setActing(true);
      try {
        await fetch(`/api/import/email-inbox/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "discard" }),
        });
        setOpenId(null);
        setDetail(null);
        await load();
      } finally {
        setActing(false);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (id: string) => {
      setActing(true);
      try {
        await fetch(`/api/import/email-inbox/${id}`, { method: "DELETE" });
        if (openId === id) {
          setOpenId(null);
          setDetail(null);
        }
        await load();
      } finally {
        setActing(false);
      }
    },
    [load, openId],
  );

  const recordableAccounts = useMemo(
    () => accounts.filter((a) => !a.archived && a.isInvestment !== true),
    [accounts],
  );

  const srcDoc = useMemo(() => {
    if (!detail?.bodyHtml) return null;
    return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font:13px -apple-system,sans-serif;margin:12px">${detail.bodyHtml}</body></html>`;
  }, [detail]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Transactions emailed to your import address. Body emails matching an
          email rule auto-record; the rest wait here for review.
        </p>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Mail className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No emails yet. Forward a bank alert or statement to your import
              address and it&apos;ll show up here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((it) => {
            const badge = BADGE[it.action];
            const isOpen = openId === it.id;
            const canRecord =
              it.action === "needs_review" && it.sourceKind === "body";
            return (
              <Card key={it.id} className={isOpen ? "ring-1 ring-primary/30" : ""}>
                <CardContent className="py-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => void openRow(it.id)}
                    >
                      <div className="flex items-center gap-2">
                        <Badge className={`${badge.cls} border-transparent`}>
                          {badge.label}
                        </Badge>
                        <span className="text-sm font-medium truncate">
                          {it.subject || "(no subject)"}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{it.fromAddress || "(unknown sender)"}</span>
                        <span>·</span>
                        <span>{new Date(it.receivedAt).toLocaleDateString()}</span>
                        {it.candidate && (
                          <>
                            <span>·</span>
                            <span className="font-medium text-foreground">
                              {formatCurrency(it.candidate.amount, it.candidate.currency)}
                            </span>
                            <span className="truncate">{it.candidate.payee}</span>
                          </>
                        )}
                      </div>
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-rose-600"
                      onClick={() => void remove(it.id)}
                      disabled={acting}
                      title="Delete email"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {isOpen && (
                    <div className="space-y-3 border-t pt-3">
                      {it.sourceKind === "attachment" && (
                        <p className="text-xs text-muted-foreground">
                          This email carried an attachment. Its rows are staged —
                          review them in the Staging tab for the relevant account.
                        </p>
                      )}

                      <div className="border rounded-lg overflow-hidden bg-background">
                        {srcDoc ? (
                          <iframe
                            title="Email body"
                            sandbox="allow-same-origin"
                            srcDoc={srcDoc}
                            className="w-full h-[320px] bg-white"
                          />
                        ) : detail?.bodyText ? (
                          <pre className="p-3 text-xs whitespace-pre-wrap max-h-[320px] overflow-auto font-mono">
                            {detail.bodyText}
                          </pre>
                        ) : (
                          <p className="p-6 text-sm text-muted-foreground text-center">
                            {detail ? "(no body content)" : "Loading…"}
                          </p>
                        )}
                      </div>

                      {canRecord && (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="space-y-1">
                            <label className="text-xs text-muted-foreground">Account</label>
                            <Select
                              value={pickAccount != null ? String(pickAccount) : ""}
                              onValueChange={(v) => setPickAccount(v ? parseInt(v, 10) : null)}
                            >
                              <SelectTrigger className="w-[200px] h-9">
                                {/* Explicit render — base-ui SelectValue otherwise
                                 *  shows the raw account id, not the name. */}
                                <SelectValue placeholder="Pick account">
                                  {pickAccount != null
                                    ? (() => {
                                        const a = recordableAccounts.find((x) => x.id === pickAccount);
                                        return a ? `${safeAccountName(a)} · ${a.currency}` : "Pick account";
                                      })()
                                    : "Pick account"}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {recordableAccounts.map((a) => (
                                  <SelectItem key={a.id} value={String(a.id)}>
                                    {safeAccountName(a)} · {a.currency}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs text-muted-foreground">Category</label>
                            <Select
                              value={pickCategory != null ? String(pickCategory) : ""}
                              onValueChange={(v) => setPickCategory(v ? parseInt(v, 10) : null)}
                            >
                              <SelectTrigger className="w-[200px] h-9">
                                <SelectValue placeholder="Pick category">
                                  {pickCategory != null
                                    ? safeName(
                                        categories.find((c) => c.id === pickCategory)?.name ?? null,
                                        "category",
                                        pickCategory,
                                      )
                                    : "Pick category"}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {categories.map((c) => (
                                  <SelectItem key={c.id} value={String(c.id)}>
                                    {safeName(c.name, "category", c.id)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => void record(it.id)}
                            disabled={acting || pickAccount == null || pickCategory == null}
                          >
                            Record
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void discard(it.id)}
                            disabled={acting}
                          >
                            Discard
                          </Button>
                        </div>
                      )}

                      {it.recordedTransactionId != null && (
                        <p className="text-xs text-emerald-700 dark:text-emerald-300">
                          Recorded as transaction #{it.recordedTransactionId}.
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
