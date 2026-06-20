"use client";

/**
 * /import — the single account-anchored money-in surface (consolidation
 * Phase 3, 2026-06-04). Formerly /inbox; the legacy /import upload hub now
 * lives at /import/classic (a temporary backup), and import MANAGEMENT
 * (templates / connectors / email-import address / investment statements)
 * lives at /settings/import.
 *
 * One page per account with a policy-driven tab set. The three policies —
 * Auto-pilot / Approve-each / Manual — are baked into `accounts.mode`. This
 * page surfaces them as tabs and lets the user temporarily flip to a
 * different lens via the chip (no persisted state) or save the lens as the
 * account's new policy via the toast.
 *
 * The Manual lens embeds the same panes shipped under /import/pending and
 * /reconcile (both still reachable, redirected to here in a later phase).
 *
 * URL state: ?account=<id> and ?tab=<tab>. The tab is persisted so deep
 * links + the legacy-route redirects can target a specific tab; on lens
 * change we re-snap to a valid tab for the new lens.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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
import { InboxToApproveTab } from "@/components/inbox/inbox-to-approve-tab";
import { InboxToCategorizeTab } from "@/components/inbox/inbox-to-categorize-tab";
import { InboxEmailTab } from "@/components/inbox/inbox-email-tab";
import { ReconcileSummaryPanel } from "@/components/inbox/reconcile-summary-panel";
import { takeHandoffFile } from "@/lib/import/file-handoff";

interface Account {
  id: number;
  name: string | null;
  alias?: string | null;
  currency: string;
  archived?: boolean;
  isInvestment?: boolean;
  mode: Mode;
  /** Statement-upload field-mapping (2026-06-04). */
  ofxPayeeSource?: "name" | "memo";
  csvMappingMode?: "confirm" | "auto";
}

function defaultTabFor(m: Mode) {
  if (m === "manual") return "staging";
  if (m === "approve") return "to-approve";
  return "to-categorize";
}

export default function ImportPage() {
  return (
    <Suspense fallback={null}>
      <ImportPageInner />
    </Suspense>
  );
}

function ImportPageInner() {
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  // FINLYNQ-188 — a file carried in from the dashboard Quick Import card.
  // Consumed once from the module-level handoff store on mount; opening the
  // UploadDrawer with this seeded file auto-runs the existing preview/staging
  // pipeline so the picked file isn't discarded.
  const [handoffFile, setHandoffFileState] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped after a successful in-drawer upload (Phase 2). Threaded into each
   *  tab body's `key` so a bump remounts the active tab → it refetches and the
   *  freshly-uploaded rows appear without leaving /inbox. */
  const [reloadKey, setReloadKey] = useState(0);
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
  // FINLYNQ-147 — account ids the user has hidden from the reconcile dropdown.
  // Dropdown-only filter; the toggle lives on /settings/import. A hidden
  // account stays selectable via a direct ?account=<id> deep-link.
  const [hiddenIds, setHiddenIds] = useState<number[]>([]);

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
        // Initial lens matches the policy of the picked account; an explicit
        // ?tab= (from a deep link or a legacy-route redirect) wins over the
        // lens default. The snap-to-valid effect corrects an out-of-set tab.
        if (pick != null) {
          const a = visible.find((x) => x.id === pick);
          const initialPolicy: Mode = a ? a.mode : "manual";
          setLens(initialPolicy);
          const urlTab = searchParams?.get("tab");
          setTab(urlTab || defaultTabFor(initialPolicy));
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

  // FINLYNQ-147 — load the per-user hidden-account list (dropdown filter).
  // Non-blocking: a failure just leaves nothing hidden.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/reconcile-hidden-accounts");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.accountIds)) {
          setHiddenIds(data.accountIds.filter((n: unknown) => typeof n === "number"));
        }
      } catch {
        // ignore — leave nothing hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // FINLYNQ-188 — consume a file handed off by the dashboard Quick Import card.
  // Runs once on mount; clearing-on-read in the store means a refresh / repeat
  // mount won't re-trigger it. Seeding the drawer auto-fires the existing
  // upload pipeline against this file (see UploadDrawer `initialFile`).
  useEffect(() => {
    const f = takeHandoffFile();
    if (f) {
      setHandoffFileState(f);
      setUploadOpen(true);
    }
  }, []);

  // Persist ?account= and ?tab= so deep links + legacy-route redirects land
  // on the right account + tab, and a refresh keeps the user in place.
  useEffect(() => {
    if (accountId == null) return;
    const url = new URL(window.location.href);
    url.searchParams.set("account", String(accountId));
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  }, [accountId, tab]);

  const account = useMemo(
    () => accounts.find((a) => a.id === accountId) ?? null,
    [accounts, accountId],
  );
  const visibleAccounts = useMemo(
    () => accounts.filter((a) => !a.archived),
    [accounts],
  );
  // FINLYNQ-147 — the dropdown shows non-archived, non-hidden accounts, BUT
  // always keeps the currently-selected account in the list so a hidden
  // deep-linked account (?account=<id>) stays selectable in the trigger.
  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const dropdownAccounts = useMemo(
    () =>
      visibleAccounts.filter((a) => !hiddenSet.has(a.id) || a.id === accountId),
    [visibleAccounts, hiddenSet, accountId],
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
  // tab set doesn't include the current tab, snap to the lens default. The
  // account-agnostic "email" tab is always valid (it's not lens-scoped).
  useEffect(() => {
    if (tab !== "email" && !visibleTabs.includes(tab)) {
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
        <h1 className="text-2xl font-semibold">Import</h1>
        <p className="text-sm text-muted-foreground">
          No accounts found. Create an account first to start importing.
        </p>
      </div>
    );
  }

  if (account == null) {
    return (
      <div className="container mx-auto p-4 space-y-3">
        <h1 className="text-2xl font-semibold">Import</h1>
        <p className="text-sm text-muted-foreground">
          Pick an account to start importing.
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
          <h1 className="text-2xl font-semibold">Import</h1>
          <p className="text-sm text-muted-foreground">
            One surface per account. Upload a statement, then review it the way
            this account is set up — pick a lens to flip the view, or change
            the account&apos;s policy via the gear in the chip.
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
                {/* Base UI SelectValue otherwise renders the raw `value`
                 *  (the account id as string, e.g. "768") on first render
                 *  before items register their text. Pass an explicit
                 *  render prop that pulls the decrypted label out of the
                 *  accounts array so the trigger always shows the
                 *  account name. (Inbox v4 Phase 5, 2026-05-27.) */}
                <SelectValue placeholder="Select an account">
                  {accountId != null
                    ? (() => {
                        const a = accounts.find((x) => x.id === accountId);
                        return a
                          ? `${safeAccountName(a)} · ${a.currency}`
                          : "Select an account";
                      })()
                    : "Select an account"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {dropdownAccounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {safeAccountName(a)} · {a.currency}
                    {hiddenSet.has(a.id) ? " · hidden" : ""}
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
            isInvestment={account.isInvestment ?? false}
          />
        </div>
        <div className="mt-3">
          <ModeBanner lens={activeLens} policy={policy} />
        </div>
      </div>

      <ReconcileSummaryPanel
        onOpenAccount={(id) => switchAccount(id)}
        reloadKey={reloadKey}
      />

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
          {/* Account-agnostic — emails aren't bound to an account until recorded. */}
          <TabsTrigger value="email">Email</TabsTrigger>
        </TabsList>

        {visibleTabs.includes("staging") && (
          <TabsContent value="staging">
            <InboxStagingTab key={`staging-${reloadKey}`} accountId={account.id} />
          </TabsContent>
        )}

        {visibleTabs.includes("reconcile") && (
          <TabsContent value="reconcile">
            <InboxReconcileTab
              key={`reconcile-${reloadKey}`}
              accountId={account.id}
              accounts={accounts}
              onReconcileDataChange={setReconcileData}
            />
          </TabsContent>
        )}

        {visibleTabs.includes("to-approve") && (
          <TabsContent value="to-approve">
            <InboxToApproveTab
              key={`to-approve-${reloadKey}`}
              accountId={account.id}
              accounts={accounts}
            />
          </TabsContent>
        )}

        {visibleTabs.includes("to-categorize") && (
          <TabsContent value="to-categorize">
            <InboxToCategorizeTab
              key={`to-categorize-${reloadKey}`}
              accountId={account.id}
              accounts={accounts}
            />
          </TabsContent>
        )}

        <TabsContent value="reconciled">
          {activeLens === "manual" ? (
            <InboxReconciledTab data={reconcileData} />
          ) : activeLens === "approve" ? (
            // Approve-each lens self-fetches the snapshot — the Reconcile
            // tab isn't rendered alongside, so there's no parent-level
            // snapshot to share.
            <InboxReconciledTab key={`reconciled-${reloadKey}`} accountId={account.id} />
          ) : (
            // Auto-pilot lens: same snapshot fetch as Approve-each, plus
            // the "X rows auto-applied by rules" banner so the user can
            // audit what the upload-time rule firing did.
            <InboxReconciledTab
              key={`reconciled-${reloadKey}`}
              accountId={account.id}
              showAutoRuleBanner
            />
          )}
        </TabsContent>

        <TabsContent value="email">
          <InboxEmailTab />
        </TabsContent>
      </Tabs>

      <UploadDrawer
        open={uploadOpen}
        onOpenChange={(o) => {
          setUploadOpen(o);
          // Drop the carried file once the drawer closes so it isn't re-fired
          // if the user reopens the drawer manually. (FINLYNQ-188)
          if (!o) setHandoffFileState(null);
        }}
        accountId={account.id}
        accountLabel={safeAccountName(account)}
        accountCurrency={account.currency}
        policy={policy}
        // FINLYNQ-195 — gate the investment column-mapping fields on the
        // bound account's is_investment flag.
        isInvestment={account.isInvestment ?? false}
        ofxPayeeSource={account.ofxPayeeSource === "memo" ? "memo" : "name"}
        csvMappingMode={account.csvMappingMode === "auto" ? "auto" : "confirm"}
        // FINLYNQ-188 — when set (carried from the dashboard Quick Import), the
        // drawer auto-runs the upload pipeline against this file on open.
        initialFile={handoffFile}
        onUploaded={() => {
          // Stay on /inbox; refresh the policy-appropriate tab so the
          // freshly-uploaded rows appear. setReconcileData(null) clears the
          // shared manual-lens snapshot; the reloadKey bump remounts each
          // tab body so it refetches.
          setReconcileData(null);
          setTab(defaultTabFor(activeLens));
          setReloadKey((k) => k + 1);
        }}
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
