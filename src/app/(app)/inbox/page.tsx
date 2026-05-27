"use client";

/**
 * /inbox — account-anchored Reconcile v4 surface (Phase 2, 2026-05-27).
 *
 * One page per account with a policy-driven tab set. The three policies —
 * Auto-pilot / Approve-each / Manual — are baked into `accounts.mode`
 * (Phase 1, commit 7e8256b). This page surfaces them as tabs and lets the
 * user temporarily flip to a different lens via the chip (no persisted
 * state) or save the lens as the account's new policy via the toast.
 *
 * Phase 2 ships Manual-lens content end-to-end (Staging → Reconcile →
 * Reconciled) by embedding the same panes shipped under /import/pending
 * and /reconcile. Auto/Approve tabs render with an "Available next phase"
 * empty state — the chip morphing + lens-toast wiring is in place so the
 * surface is exercisable today.
 *
 * Routes preserved unchanged for back-compat:
 *   /import, /import/pending, /reconcile — same byte-identical surfaces.
 *
 * URL state: ?account=<id>. Tabs are session-local (no URL persist) since
 * the default tab follows the lens and we re-snap on every lens change.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Upload } from "lucide-react";
import { safeAccountName } from "@/lib/safe-name";
import { LensChip } from "@/components/inbox/lens-chip";
import { LensToast } from "@/components/inbox/lens-toast";
import { ModeBanner } from "@/components/inbox/mode-banner";
import { UploadDrawer } from "@/components/inbox/upload-drawer";
import { isMode, type Mode } from "@/components/inbox/modes";
import { InboxStagingTab } from "@/components/inbox/inbox-staging-tab";
import {
  InboxReconcileTab,
  type ReconcileData,
} from "@/components/inbox/inbox-reconcile-tab";
import { InboxReconciledTab } from "@/components/inbox/inbox-reconciled-tab";
import { AvailableNextPhase } from "@/components/inbox/available-next-phase";

interface Account {
  id: number;
  name: string | null;
  alias?: string | null;
  currency: string;
  archived?: boolean;
  isInvestment?: boolean;
  mode: Mode;
}

function defaultTabFor(m: Mode) {
  if (m === "manual") return "staging";
  if (m === "approve") return "to-approve";
  return "to-categorize";
}

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}

function InboxPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Reconcile snapshot is fetched by InboxReconcileTab and bubbled up
   *  so InboxReconciledTab can re-render the same data filtered to the
   *  linked rows — avoids fetching the same endpoint twice. */
  const [reconcileData, setReconcileData] = useState<ReconcileData | null>(
    null,
  );

  // Per-render lens override. Reset to the account's stored policy when
  // the account changes; the toast nudges the user to persist if they
  // want this lens to become the new policy.
  const [lens, setLens] = useState<Mode | null>(null);
  const [tab, setTab] = useState<string>("staging");
  const [savingPolicy, setSavingPolicy] = useState(false);

  // ─── Load accounts ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/accounts");
        if (!res.ok) throw new Error(`accounts: ${res.status}`);
        const rows: Account[] = await res.json();
        if (cancelled) return;
        // Defensive default — older accounts created before the Phase 1
        // migration ran would have NULL mode; the migration backfills
        // 'manual', but a stale fetch could still land here.
        const normalized = rows.map((a) => ({
          ...a,
          mode: isMode(a.mode) ? a.mode : ("manual" as Mode),
        }));
        setAccounts(normalized);
        const visible = normalized.filter((a) => !a.archived);
        const urlAccount = searchParams?.get("account");
        const urlId = urlAccount ? parseInt(urlAccount, 10) : NaN;
        const pick =
          Number.isFinite(urlId) && visible.some((a) => a.id === urlId)
            ? urlId
            : (visible[0]?.id ?? null);
        setAccountId(pick);
        // Initial lens matches the policy of the picked account.
        if (pick != null) {
          const a = visible.find((x) => x.id === pick);
          setLens(a ? a.mode : "manual");
          setTab(defaultTabFor(a ? a.mode : "manual"));
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setAccountsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // searchParams is referentially stable per Next.js docs but the lint
    // rule still flags it; we intentionally only read it on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist ?account= when the user flips accounts.
  useEffect(() => {
    if (accountId == null) return;
    const url = new URL(window.location.href);
    url.searchParams.set("account", String(accountId));
    window.history.replaceState({}, "", url.toString());
  }, [accountId]);

  const account = useMemo(
    () => accounts.find((a) => a.id === accountId) ?? null,
    [accounts, accountId],
  );
  const visibleAccounts = useMemo(
    () => accounts.filter((a) => !a.archived),
    [accounts],
  );
  const policy: Mode = account?.mode ?? "manual";
  const activeLens: Mode = lens ?? policy;
  const isLensActive = activeLens !== policy;

  const switchAccount = (id: number) => {
    setAccountId(id);
    setReconcileData(null);
    const next = accounts.find((a) => a.id === id);
    const nextPolicy: Mode = next?.mode ?? "manual";
    setLens(nextPolicy);
    setTab(defaultTabFor(nextPolicy));
  };

  const onLensChange = (m: Mode) => {
    setLens(m);
    setTab(defaultTabFor(m));
  };

  // visibleTabs encodes the per-lens tab set per the v4 preview spec.
  const visibleTabs = useMemo<string[]>(() => {
    if (activeLens === "manual") return ["staging", "reconcile", "reconciled"];
    if (activeLens === "approve") return ["to-approve", "reconciled"];
    return ["to-categorize", "reconciled"];
  }, [activeLens]);

  // Keep `tab` valid for the visible set. If the user picks a lens whose
  // tab set doesn't include the current tab, snap to the lens default.
  useEffect(() => {
    if (!visibleTabs.includes(tab)) {
      setTab(defaultTabFor(activeLens));
    }
  }, [visibleTabs, tab, activeLens]);

  const onSavePolicy = useCallback(async () => {
    if (account == null || lens == null || lens === policy) return;
    setSavingPolicy(true);
    try {
      const res = await fetch(`/api/accounts/${account.id}/mode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: lens }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Mirror the server's new policy locally so the chip + banner
      // stabilize without re-fetching the entire accounts list.
      setAccounts((prev) =>
        prev.map((a) => (a.id === account.id ? { ...a, mode: lens } : a)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPolicy(false);
    }
  }, [account, lens, policy]);

  const onRevertLens = () => {
    if (account == null) return;
    setLens(policy);
    setTab(defaultTabFor(policy));
  };

  const onKeepLens = () => {
    // Lens stays as-is — the toast just disappears. The chip's active
    // ring is the only persisted UI cue that the lens is still flipped.
    // We don't store anything beyond the in-memory `lens` state.
  };

  if (accountsLoading) {
    return (
      <div className="container mx-auto p-4">
        <p className="text-sm text-muted-foreground">Loading accounts…</p>
      </div>
    );
  }

  if (visibleAccounts.length === 0) {
    return (
      <div className="container mx-auto p-4 space-y-3">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          No accounts found. Create an account first to start reconciling.
        </p>
      </div>
    );
  }

  if (account == null) {
    return (
      <div className="container mx-auto p-4 space-y-3">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          Pick an account to start reconciling.
        </p>
      </div>
    );
  }

  // Toast is visible whenever the lens differs from the account's policy.
  // Save-as-default in the toast is what flips the policy server-side.
  const showLensToast = isLensActive && !savingPolicy;

  return (
    <div className="container mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Inbox</h1>
            <Badge
              variant="outline"
              className="text-[10px] font-mono uppercase tracking-wider"
            >
              v4 · lens + policy
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            One surface per account. Pick a lens to flip the view —
            change the account&apos;s policy via the gear in the chip.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => setUploadOpen(true)}
          >
            <Upload className="h-4 w-4" /> Upload
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Account
            </span>
            <Select
              value={accountId != null ? String(accountId) : ""}
              onValueChange={(v) => {
                const n = parseInt(v ?? "", 10);
                if (Number.isFinite(n)) switchAccount(n);
              }}
            >
              <SelectTrigger className="w-[260px]">
                <SelectValue placeholder="Select an account" />
              </SelectTrigger>
              <SelectContent>
                {visibleAccounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {safeAccountName(a)} · {a.currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <LensChip
            lens={activeLens}
            policy={policy}
            onLensChange={onLensChange}
            accountId={account.id}
          />
        </div>
        <div className="mt-3">
          <ModeBanner lens={activeLens} policy={policy} />
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v ?? defaultTabFor(activeLens))}
        className="gap-4"
      >
        <TabsList className="h-9">
          {visibleTabs.includes("staging") && (
            <TabsTrigger value="staging">Staging</TabsTrigger>
          )}
          {visibleTabs.includes("reconcile") && (
            <TabsTrigger value="reconcile">Reconcile</TabsTrigger>
          )}
          {visibleTabs.includes("to-approve") && (
            <TabsTrigger value="to-approve">To approve</TabsTrigger>
          )}
          {visibleTabs.includes("to-categorize") && (
            <TabsTrigger value="to-categorize">To categorize</TabsTrigger>
          )}
          <TabsTrigger value="reconciled">Reconciled</TabsTrigger>
        </TabsList>

        {visibleTabs.includes("staging") && (
          <TabsContent value="staging">
            <InboxStagingTab accountId={account.id} />
          </TabsContent>
        )}

        {visibleTabs.includes("reconcile") && (
          <TabsContent value="reconcile">
            <InboxReconcileTab
              accountId={account.id}
              accounts={accounts}
              onReconcileDataChange={setReconcileData}
            />
          </TabsContent>
        )}

        {visibleTabs.includes("to-approve") && (
          <TabsContent value="to-approve">
            <AvailableNextPhase
              phase="Phase 3"
              feature="Approve-each card flow — one-click ledger commit per bank row with suggestions"
            />
          </TabsContent>
        )}

        {visibleTabs.includes("to-categorize") && (
          <TabsContent value="to-categorize">
            <AvailableNextPhase
              phase="Phase 4"
              feature="Auto-pilot rule-firing-at-upload — rules categorize at upload, the unmatched land here"
            />
          </TabsContent>
        )}

        <TabsContent value="reconciled">
          {activeLens === "manual" ? (
            <InboxReconciledTab data={reconcileData} />
          ) : (
            <AvailableNextPhase
              phase={activeLens === "approve" ? "Phase 3" : "Phase 4"}
              feature="The reconciled view for this lens shows the rule / auto / manual provenance pills landing alongside the card content."
            />
          )}
        </TabsContent>
      </Tabs>

      <UploadDrawer
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        accountId={account.id}
        accountLabel={safeAccountName(account)}
        policy={policy}
      />

      {showLensToast && (
        <LensToast
          lens={activeLens}
          accountLabel={safeAccountName(account)}
          onSave={onSavePolicy}
          onKeep={onKeepLens}
          onRevert={onRevertLens}
          saving={savingPolicy}
        />
      )}
    </div>
  );
}
