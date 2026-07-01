"use client";

/**
 * /settings/bank-feeds — SimpleFIN bank feed (on-demand sync).
 *
 * Paste a SimpleFIN setup token to connect, then "Sync now" DETECTS the bank's
 * accounts. For each new account the user chooses to Create a Finlynq account or
 * Link to an existing one; already-linked accounts sync silently. Confirming
 * STAGES the transactions into /import/pending for review + approval (which
 * promotes them to the bank ledger / reconciliation). On-demand only — the
 * access URL is encrypted under your DEK, available only while logged in.
 *
 * Settings-page convention: bespoke fetch/useState/useEffect (no SWR), shared
 * ConfirmDialog for disconnect, parseSaveError for failed mutations.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { parseSaveError } from "@/lib/save-error";
import { cn } from "@/lib/utils";
import { Landmark, Loader2, RefreshCw, CheckCircle2, ExternalLink, Link2, Plus } from "lucide-react";

interface SimplefinStatus {
  connected: boolean;
  lastSyncAt: string | null;
}

type AccountStatus = "mapped" | "suggested" | "new";
interface AccountPlan {
  externalId: string;
  name: string;
  currency: string;
  txCount: number;
  status: AccountStatus;
  accountId: number | null;
  accountName: string | null;
}
interface ExistingAccount {
  id: number;
  name: string;
  currency: string;
}
interface Preview {
  accounts: AccountPlan[];
  existingAccounts: ExistingAccount[];
  errors: string[];
}

type Choice = { mode: "create" } | { mode: "existing"; accountId: number };

interface StagedResult {
  stagedImportId: string;
  accountId: number;
  accountName: string;
  rowCount: number;
  newCount: number;
  duplicateCount: number;
}
interface SyncResult {
  staged: StagedResult[];
  accountsCreated: number;
  skippedNoChoice: Array<{ externalId: string; name: string }>;
  skippedPending: number;
  errors: string[];
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function BankFeedsSettingsPage() {
  const [status, setStatus] = useState<SimplefinStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");

  const [detecting, setDetecting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [detectError, setDetectError] = useState("");

  const [staging, setStaging] = useState(false);
  const [stageError, setStageError] = useState("");
  const [stageResult, setStageResult] = useState<SyncResult | null>(null);

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/settings/bank-feeds/simplefin/status");
      if (!res.ok) {
        setLoadError(await parseSaveError(res, "Failed to load bank feed status"));
        setStatus(null);
        return;
      }
      setStatus(await res.json());
    } catch {
      setLoadError("Failed to load bank feed status");
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleConnect() {
    if (!token.trim()) return;
    setConnecting(true);
    setConnectError("");
    try {
      const res = await fetch("/api/settings/bank-feeds/simplefin/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupToken: token.trim() }),
      });
      if (!res.ok) {
        setConnectError(await parseSaveError(res, "Failed to connect"));
        return;
      }
      setToken("");
      await load();
    } catch {
      setConnectError("Failed to connect");
    } finally {
      setConnecting(false);
    }
  }

  async function handleDetect() {
    setDetecting(true);
    setDetectError("");
    setStageResult(null);
    setPreview(null);
    try {
      const res = await fetch("/api/settings/bank-feeds/simplefin/preview", { method: "POST" });
      if (!res.ok) {
        setDetectError(await parseSaveError(res, "Failed to detect accounts"));
        return;
      }
      const data: Preview = await res.json();
      setPreview(data);
      // Seed default choices: suggested → link to the suggestion, new → create.
      const seeded: Record<string, Choice> = {};
      for (const a of data.accounts) {
        if (a.status === "suggested" && a.accountId != null) {
          seeded[a.externalId] = { mode: "existing", accountId: a.accountId };
        } else if (a.status === "new") {
          seeded[a.externalId] = { mode: "create" };
        }
      }
      setChoices(seeded);
    } catch {
      setDetectError("Failed to detect accounts");
    } finally {
      setDetecting(false);
    }
  }

  async function handleStage() {
    if (!preview) return;
    setStaging(true);
    setStageError("");
    try {
      const res = await fetch("/api/settings/bank-feeds/simplefin/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choices }),
      });
      if (!res.ok) {
        setStageError(await parseSaveError(res, "Import failed"));
        return;
      }
      setStageResult(await res.json());
      setPreview(null);
      await load();
    } catch {
      setStageError("Import failed");
    } finally {
      setStaging(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/settings/bank-feeds/simplefin/disconnect", {
        method: "DELETE",
      });
      if (!res.ok) return;
      setConfirmDisconnect(false);
      setPreview(null);
      setStageResult(null);
      await load();
    } finally {
      setDisconnecting(false);
    }
  }

  const setChoice = (externalId: string, choice: Choice) =>
    setChoices((prev) => ({ ...prev, [externalId]: choice }));

  const totalToStage = preview
    ? preview.accounts.reduce(
        (n, a) => (a.status === "mapped" || choices[a.externalId] ? n + a.txCount : n),
        0,
      )
    : 0;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Bank feeds</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Pull transactions automatically from your bank via SimpleFIN
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
              <Landmark className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base flex items-center gap-2">
                SimpleFIN
                {status?.connected && (
                  <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-600/40">
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Connected
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                An open bank-feed protocol. You link your banks at simplefin.org ($15/yr, paid
                directly to SimpleFIN) and paste a one-time setup token here. Synced transactions go
                to your import review queue for approval — Finlynq never sees your bank login.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : loadError ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-destructive">{loadError}</p>
              <Button variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            </div>
          ) : status?.connected ? (
            <div className="space-y-4">
              {/* ── Header row: last sync + actions ── */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {status.lastSyncAt
                    ? `Last synced ${formatDateTime(status.lastSyncAt)}`
                    : "Not synced yet"}
                </p>
                <div className="flex items-center gap-2">
                  {!preview && (
                    <Button size="sm" onClick={handleDetect} disabled={detecting}>
                      {detecting ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Detecting…
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-1.5" /> Sync now
                        </>
                      )}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmDisconnect(true)}
                  >
                    Disconnect
                  </Button>
                </div>
              </div>

              {detectError && <p className="text-sm text-destructive">{detectError}</p>}
              {stageError && <p className="text-sm text-destructive">{stageError}</p>}

              {/* ── Detected accounts: create/link mapping ── */}
              {preview && (
                <div className="rounded-xl border divide-y">
                  <div className="px-4 py-2.5 text-sm font-medium bg-muted/30">
                    Detected accounts — choose how each maps to Finlynq
                  </div>
                  {preview.accounts.map((a) => (
                    <div key={a.externalId} className="px-4 py-3 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{a.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {a.currency} · {a.txCount} transaction{a.txCount === 1 ? "" : "s"}
                          </p>
                        </div>
                        {a.status === "mapped" && (
                          <Badge variant="outline" className="text-xs shrink-0">
                            <Link2 className="h-3 w-3 mr-1" /> Linked to {a.accountName}
                          </Badge>
                        )}
                      </div>

                      {a.status !== "mapped" && (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant={choices[a.externalId]?.mode === "create" ? "default" : "outline"}
                            onClick={() => setChoice(a.externalId, { mode: "create" })}
                          >
                            <Plus className="h-3.5 w-3.5 mr-1" /> Create new
                          </Button>
                          {preview.existingAccounts.length > 0 && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant={
                                  choices[a.externalId]?.mode === "existing" ? "default" : "outline"
                                }
                                onClick={() =>
                                  setChoice(a.externalId, {
                                    mode: "existing",
                                    accountId:
                                      a.accountId ?? preview.existingAccounts[0].id,
                                  })
                                }
                              >
                                <Link2 className="h-3.5 w-3.5 mr-1" /> Link existing
                              </Button>
                              {choices[a.externalId]?.mode === "existing" && (
                                <select
                                  value={
                                    (choices[a.externalId] as { accountId: number }).accountId
                                  }
                                  onChange={(e) =>
                                    setChoice(a.externalId, {
                                      mode: "existing",
                                      accountId: Number(e.target.value),
                                    })
                                  }
                                  className={cn(
                                    "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none",
                                    "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
                                  )}
                                >
                                  {preview.existingAccounts.map((ea) => (
                                    <option key={ea.id} value={ea.id}>
                                      {ea.name} ({ea.currency})
                                    </option>
                                  ))}
                                </select>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  <div className="px-4 py-3 flex items-center justify-between gap-3">
                    <Button variant="ghost" size="sm" onClick={() => setPreview(null)} disabled={staging}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleStage} disabled={staging}>
                      {staging ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Importing…
                        </>
                      ) : (
                        `Import ${totalToStage} to review`
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {/* ── Result after staging ── */}
              {stageResult && (
                <div className="rounded-xl border bg-muted/30 p-4 space-y-2">
                  <p className="text-sm font-medium">Ready for review</p>
                  <p className="text-sm text-muted-foreground">
                    {stageResult.staged.reduce((n, s) => n + s.rowCount, 0)} transaction
                    {stageResult.staged.reduce((n, s) => n + s.rowCount, 0) === 1 ? "" : "s"} staged
                    across {stageResult.staged.length} account
                    {stageResult.staged.length === 1 ? "" : "s"}
                    {stageResult.accountsCreated > 0
                      ? ` · ${stageResult.accountsCreated} account${stageResult.accountsCreated === 1 ? "" : "s"} created`
                      : ""}
                    {stageResult.skippedPending > 0
                      ? ` · ${stageResult.skippedPending} pending skipped`
                      : ""}
                    .
                  </p>
                  {stageResult.skippedNoChoice.length > 0 && (
                    <p className="text-xs text-amber-600">
                      Skipped (no choice made):{" "}
                      {stageResult.skippedNoChoice.map((s) => s.name).join(", ")}
                    </p>
                  )}
                  <Link
                    href="/import/pending"
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    Review &amp; approve in Import <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </div>
              )}
            </div>
          ) : (
            /* ── Not connected: paste setup token ── */
            <div className="space-y-3">
              <label htmlFor="simplefin-token" className="block text-sm font-medium">
                Setup token
              </label>
              <textarea
                id="simplefin-token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={3}
                placeholder="Paste your SimpleFIN setup token…"
                className={cn(
                  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm font-mono transition-colors outline-none",
                  "placeholder:text-muted-foreground placeholder:font-sans focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                  "disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30",
                )}
                disabled={connecting}
              />
              {connectError && <p className="text-sm text-destructive">{connectError}</p>}
              <div className="flex items-center justify-between gap-3">
                <a
                  href="https://beta-bridge.simplefin.org/"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  Where do I get a token? <ExternalLink className="h-3 w-3" />
                </a>
                <Button size="sm" onClick={handleConnect} disabled={connecting || !token.trim()}>
                  {connecting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Connecting…
                    </>
                  ) : (
                    "Connect"
                  )}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect SimpleFIN"
        description={
          <>
            Disconnect SimpleFIN? Your stored access is removed and no more transactions will be
            pulled. Already-imported transactions are kept — you can reconnect later with a new setup
            token.
          </>
        }
        confirmLabel="Disconnect"
        busyLabel="Disconnecting…"
        busy={disconnecting}
        onConfirm={handleDisconnect}
      />
    </div>
  );
}
