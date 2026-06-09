"use client";

/**
 * StagedReviewSurface — the staged-import review surface (list + two-pane
 * detail). Consolidation Phase 5 (2026-06-04): extracted verbatim from
 * import/pending/page.tsx so BOTH the standalone /import/pending route AND
 * the account-anchored /import Staging tab render the SAME implementation.
 *
 * Two modes:
 *   - List view (openId == null): pending batches; click to open.
 *   - Two-pane review (openId != null): AccountSelector + DbPane (left) +
 *     FilePane (right) + ReconciliationCallout + BalanceWarningBanner +
 *     UnresolvedCategoriesBanner + Approve/Discard footer.
 *
 * Props:
 *   - `embedded` (default false): when true, this is rendered inside the
 *     /import Staging tab. URL `?id=`/`?account=` read+write is suppressed
 *     (openId/accountId are pure local state), the list is filtered to
 *     `accountScope`, and StagedListView drops its standalone-page chrome.
 *     Route mode (embedded=false) keeps the URL-driven behaviour verbatim.
 *   - `accountScope`: the account the embedded surface is scoped to.
 *
 * Data fetching is in import/pending/_hooks/use-staged.ts; the visible
 * sub-surfaces are in import/pending/_components/. Behaviour-preserving.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Info } from "lucide-react";
import { ReconciliationCallout } from "@/components/staging/reconciliation-callout";
import {
  type StagedEditableRow,
} from "@/components/staging/staged-row-editor";
import { UnresolvedCategoriesBanner } from "@/components/staging/unresolved-categories-banner";
import {
  BalanceWarningBanner,
  type BalanceWarning,
} from "@/components/staging/balance-warning-banner";
import { AccountSelector, type AccountOption } from "@/components/import/reconcile/account-selector";
import { TwoPaneLayout } from "@/components/import/reconcile/two-pane-layout";
import { safeName } from "@/lib/safe-name";
import {
  latestBankLedgerBalance,
  sendableDelta,
} from "@/lib/import/bank-ledger-projection";
import { type DbTransactionRow } from "@/components/import/reconcile/db-pane";
import {
  type SuggestionDisplay,
} from "@/components/import/reconcile/suggestions-group";
import { ConfirmDeleteBankRow } from "@/components/reconcile/confirm-delete-bank-row";
import { Link as LinkIcon, X as XIcon } from "lucide-react";

import { type StagedDetail, shiftDays } from "@/app/(app)/import/pending/_types";
import {
  useStagedImports,
  useStagedDetail,
  useBankLedger,
} from "@/app/(app)/import/pending/_hooks/use-staged";
import { StagedListView } from "@/app/(app)/import/pending/_components/staged-list-view";
import { ReconcileHeader } from "@/app/(app)/import/pending/_components/reconcile-header";
import { BankPane } from "@/app/(app)/import/pending/_components/bank-pane";
import { StagedPane } from "@/app/(app)/import/pending/_components/staged-pane";
import { UnboundPickerPane } from "@/app/(app)/import/pending/_components/unbound-picker-pane";

export function StagedReviewSurface({
  embedded = false,
  accountScope = null,
}: {
  embedded?: boolean;
  accountScope?: number | null;
}) {
  const { list, loading, error, loadList } = useStagedImports();
  const [openId, setOpenId] = useState<string | null>(null);
  const {
    detail,
    setDetail,
    detailLoading,
    setDetailLoading,
    accounts,
    holdings,
    loadDetail,
  } = useStagedDetail();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [unresolved, setUnresolved] = useState<{ rowIds: string[]; payees: string[] } | null>(null);
  // FINLYNQ-56 — two-pane state.
  const [accountId, setAccountId] = useState<number | null>(null);
  // Phase 3 — match-action state.
  // Local-only set of rejected suggestion pairs ("stagedRowId:transactionId").
  // Per sub-item FINLYNQ-71 the reject is intentionally NOT persisted —
  // the matcher re-runs on every GET and we just hide the rejected pair
  // for the lifetime of this page state.
  const [rejectedSuggestions, setRejectedSuggestions] = useState<Set<string>>(new Set());
  // When set, the user clicked "Link" on a staged row and is awaiting a
  // DB-row click to complete the pair.
  const [linkMode, setLinkMode] = useState<{ stagedRowId: string } | null>(null);
  // The suggestion-card or row whose action is currently in flight —
  // disables its buttons so a double-click can't double-fire the PATCH.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // FINLYNQ-88 — Re-apply rules confirmation modal.
  const [reapplyModalOpen, setReapplyModalOpen] = useState(false);
  const [reapplying, setReapplying] = useState(false);
  // Plan #5 Phase 3 — click-to-highlight on both panes. Mirrors the
  // /reconcile implementation: clicking a row tints its neighborhood
  // (linked counterpart + transfer-pair peer when present); clicking
  // the same row toggles the highlight off; clicking a different row
  // swaps in the new neighborhood. Transient — page state, not URL.
  const [highlightedStagedIds, setHighlightedStagedIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [highlightedBankIds, setHighlightedBankIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  /** Anchor encoded as `staged:<id>` or `bank:<uuid>`. Null = no
   *  active highlight; second click on the same row clears it. */
  const [highlightAnchor, setHighlightAnchor] = useState<string | null>(null);

  /** Per-row bank-transaction delete (2026-05-27). Mirrors /reconcile's
   *  flow: first fetch sends empty body; server returns 409 +
   *  requiresConfirmation when the row has linked transactions, and the
   *  modal lets the user pick "Delete all" vs "Keep tx". */
  const [bankDeleteConfirm, setBankDeleteConfirm] = useState<{
    bankId: string;
    date: string;
    amount: number;
    currency: string;
    payee: string | null;
    linkedTransactionCount: number;
  } | null>(null);

  const onLedgerError = useCallback((msg: string) => {
    setToast({ type: "error", msg });
  }, []);
  const { dbRows, setDbRows, dbRowsLoading, reload: reloadBankLedger } = useBankLedger(accountId, onLedgerError);

  const openDetail = useCallback(
    async (id: string) => {
      setOpenId(id);
      setExpandedRows(new Set());
      try {
        const data = await loadDetail(id);
        setSelected(
          new Set(
            data.rows
              .filter(
                (r) =>
                  !r.isDuplicate &&
                  r.reconcileState !== "skipped_duplicate" &&
                  // Already pushed to the bank ledger on a prior send — kept
                  // visible (highlighted "imported") but not re-selectable.
                  r.rowStatus !== "approved",
              )
              .map((r) => r.id),
          ),
        );
      } catch (e) {
        setToast({ type: "error", msg: e instanceof Error ? e.message : "Failed to load" });
        setOpenId(null);
      }
    },
    [loadDetail],
  );

  const closeDetail = useCallback(() => {
    setOpenId(null);
    setDetail(null);
    setSelected(new Set());
    setExpandedRows(new Set());
    setUnresolved(null);
    setAccountId(null);
    setDbRows([]);
    // Clear ?id= and ?account= from URL when returning to the list. Route
    // mode only — embedded mode keeps openId as pure local state and never
    // touches the /import URL.
    if (!embedded && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("id");
      url.searchParams.delete("account");
      window.history.replaceState({}, "", url.toString());
    }
  }, [setDetail, setDbRows, embedded]);

  const searchParams = useSearchParams();
  useEffect(() => {
    // Embedded mode is driven by local openId (set on card click), not the
    // /import URL — so don't auto-open from ?id=.
    if (embedded) return;
    const idFromUrl = searchParams?.get("id");
    if (idFromUrl && idFromUrl !== openId) {
      void openDetail(idFromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Derive the per-account option list from already-loaded staged rows.
  // Groups by decoded accountName; resolves each to an accounts.id via
  // the loaded catalog. Falls back to staged.boundAccountId when per-row
  // accountName resolution returns nothing (the common single-account
  // OFX/QFX case where rows don't carry an explicit account name).
  const accountOptions: AccountOption[] = useMemo(() => {
    if (!detail) return [];
    const byName = new Map<string, number>();
    for (const r of detail.rows) {
      const name = r.accountName?.trim();
      if (!name) continue;
      byName.set(name, (byName.get(name) ?? 0) + 1);
    }
    // Fall back to `Account #<id>` when the loaded account's name decrypted
    // to null/empty (DEK not in cache → decryptNamedRows returns null). The
    // raw integer would otherwise surface in the AccountSelector trigger.
    const opts: AccountOption[] = [];
    for (const [name, count] of byName) {
      const match = accounts.find((a) => a.name === name);
      if (match) {
        opts.push({
          id: match.id,
          name: safeName(match.name, "Account", match.id),
          currency: match.currency,
          rowCount: count,
        });
      }
    }
    if (opts.length === 0 && detail.staged.boundAccountId != null) {
      const bound = accounts.find((a) => a.id === detail.staged.boundAccountId);
      if (bound) {
        opts.push({
          id: bound.id,
          name: safeName(bound.name, "Account", bound.id),
          currency: bound.currency,
          rowCount: detail.rows.length,
        });
      }
    }
    return opts;
  }, [detail, accounts]);

  // Pick a default account: URL ?account= → first option's id → null.
  useEffect(() => {
    if (!detail || accountOptions.length === 0) return;
    // Embedded mode prefers the surface's accountScope; route mode reads
    // ?account= from the URL. Both fall back to the first option.
    const fromUrl = embedded ? null : searchParams?.get("account");
    const parsed = fromUrl ? parseInt(fromUrl, 10) : NaN;
    const fromUrlIsValid =
      Number.isFinite(parsed) && accountOptions.some((o) => o.id === parsed);
    const scopeIsValid =
      embedded &&
      accountScope != null &&
      accountOptions.some((o) => o.id === accountScope);
    const next = fromUrlIsValid
      ? parsed
      : scopeIsValid
        ? (accountScope as number)
        : accountOptions[0].id;
    if (next !== accountId) {
      setAccountId(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, accountOptions]);

  // Persist accountId into the URL on every change (history.replaceState
  // so back/forward isn't polluted with intra-page transitions).
  useEffect(() => {
    // Embedded mode never writes ?id=/?account= to the /import URL.
    if (embedded) return;
    if (typeof window === "undefined") return;
    if (!openId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("id", openId);
    if (accountId != null) {
      url.searchParams.set("account", String(accountId));
    } else {
      url.searchParams.delete("account");
    }
    window.history.replaceState({}, "", url.toString());
  }, [openId, accountId, embedded]);

  // dbWindow was the ±7d date window used by the previous reconciliation
  // endpoint (transactions). The bank-ledger endpoint shows the full
  // continuous history per account — the window is no longer needed.
  // shiftDays is still imported for any future date-arithmetic; keeping
  // the helper alive avoids an unused-import warning.
  void shiftDays;

  // Filter staged rows to the currently-selected account. Empty
  // accountName matches every account (legacy rows pre-FINLYNQ-58 where
  // boundAccountId was set but the row didn't carry an accountName).
  const filteredStagedRows = useMemo(() => {
    if (!detail || !accountId) return [];
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return detail.rows;
    return detail.rows.filter((r) => {
      const rn = r.accountName?.trim();
      return !rn || rn === account.name;
    });
  }, [detail, accountId, accounts]);

  // 2026-05-24 — parsed anchors → date map for the FilePane's per-day
  // Balance column. Plus the upload-form statement_balance lifted as a
  // synthetic anchor when present (mirrors the approve-time dedup pass:
  // parser-extracted source wins over upload_form on date collision).
  const stagedAnchorsByDate = useMemo(() => {
    const map = new Map<string, number>();
    const parsed = detail?.staged.parsedAnchors;
    if (Array.isArray(parsed)) {
      for (const a of parsed) {
        if (typeof a?.date === "string" && typeof a?.balance === "number") {
          map.set(a.date, a.balance);
        }
      }
    }
    const sb = detail?.staged.statementBalance;
    const sd = detail?.staged.statementBalanceDate;
    if (typeof sb === "number" && typeof sd === "string" && !map.has(sd)) {
      map.set(sd, sb);
    }
    return map;
  }, [detail]);

  // 2026-06-04 — existing bank-ledger drift, surfaced through the SAME rich
  // BalanceWarningBanner the staged-file check uses (collapsible Date / Prior
  // anchor / Expected / Bank says / Δ table) so the experience matches the
  // pre-consolidation view. Built from dbRows' per-day Calculated
  // (runningBalance = Expected) vs Loaded (anchorBalance = Bank says) — the
  // same numbers the bank pane shows — with the prior anchored day as the
  // "Prior anchor". Deduped by date (the server stamps the same balances on
  // every row of a day) and cent-rounded so float noise isn't flagged.
  const bankLedgerWarnings = useMemo<BalanceWarning[]>(() => {
    const byDate = new Map<string, { anchor: number; running: number | null }>();
    for (const r of dbRows) {
      if (r.anchorBalance == null) continue;
      if (!byDate.has(r.date)) {
        byDate.set(r.date, {
          anchor: r.anchorBalance,
          running: r.runningBalance ?? null,
        });
      }
    }
    const anchors = Array.from(byDate.entries())
      .map(([date, v]) => ({ date, anchor: v.anchor, running: v.running }))
      .sort((a, z) => a.date.localeCompare(z.date));
    const out: BalanceWarning[] = [];
    for (let i = 1; i < anchors.length; i++) {
      const cur = anchors[i];
      const prev = anchors[i - 1];
      if (cur.running == null) continue;
      const expected = cur.running;
      const actual = cur.anchor;
      const delta = Math.round((actual - expected) * 100) / 100;
      if (Math.abs(delta) <= 0.01) continue;
      out.push({
        date: cur.date,
        expected,
        actual,
        delta,
        priorAnchorDate: prev.date,
        priorAnchorBalance: prev.anchor,
        intervalSum: Math.round((expected - prev.anchor) * 100) / 100,
      });
    }
    return out;
  }, [dbRows]);
  const driftCurrency = dbRows[0]?.currency ?? "USD";

  // Anchors-only approve detector. When every staged row is already in
  // the bank ledger (skipped_duplicate) or already linked to a system-side
  // transaction, the default-approve path materializes zero rows but
  // STILL commits the file's balance anchors. Surface a hint so the user
  // knows clicking Approve isn't a no-op.
  const anchorsOnlyHint = useMemo(() => {
    if (!detail || detail.staged.boundAccountId == null) return null;
    const anchorCount = stagedAnchorsByDate.size;
    if (anchorCount === 0) return null;
    const eligibleRowCount = detail.rows.filter(
      (r) =>
        r.reconcileState !== "skipped_duplicate" &&
        r.reconcileState !== "linked",
    ).length;
    if (eligibleRowCount > 0) return null;
    return {
      anchorCount,
      totalRows: detail.rows.length,
    };
  }, [detail, stagedAnchorsByDate]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((rowId: string) => {
    setExpandedRows((s) => {
      const next = new Set(s);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }, []);

  const onRowUpdated = useCallback((updated: StagedEditableRow) => {
    setDetail((d) => {
      if (!d) return d;
      return {
        ...d,
        rows: d.rows.map((x) => (x.id === updated.id ? updated : x)),
      };
    });
  }, [setDetail]);

  // ─── Phase 3 — match-action helpers ──────────────────────────────────────

  /** Generic PATCH wrapper that hits the staged-row endpoint, updates the
   *  local row on success, and surfaces a toast on failure. Used by every
   *  staged-side action (accept-suggestion, unlink, skip, unskip, link). */
  const patchStagedRow = useCallback(
    async (
      rowId: string,
      updates: Partial<{
        reconcileState: "unmatched" | "auto_suggested" | "linked" | "skipped_duplicate";
        linkedTransactionId: number | null;
      }>,
      busyKeyForCall: string,
    ): Promise<StagedEditableRow | null> => {
      if (!openId) return null;
      setBusyKey(busyKeyForCall);
      try {
        const res = await fetch(
          `/api/import/staged/${openId}/rows/${rowId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updates),
          },
        );
        const data = await res.json();
        if (res.status === 423) {
          throw new Error(
            data?.message ||
              "Your session needs to be unlocked. Reload and sign in again.",
          );
        }
        if (!res.ok) {
          throw new Error(data?.error || "Failed to update row");
        }
        const updated = data.row as StagedEditableRow;
        setDetail((d) => {
          if (!d) return d;
          return {
            ...d,
            rows: d.rows.map((x) => (x.id === updated.id ? updated : x)),
          };
        });
        return updated;
      } catch (e) {
        setToast({
          type: "error",
          msg: e instanceof Error ? e.message : "Failed to update row",
        });
        return null;
      } finally {
        setBusyKey(null);
      }
    },
    [openId, setDetail],
  );

  /** Mirror the back-reference on a DB row in local state so the
   *  "linked to staged #X" indicator updates within the 500ms target.
   *  The server doesn't carry an inverse FK on `transactions`; the
   *  on-screen state is the source of truth between fetches. */
  const updateDbRowLink = useCallback(
    (transactionId: number, linkedStagedRowId: string | null) => {
      setDbRows((rows) =>
        rows.map((r) =>
          // Two-ledger refactor (2026-05-22): DbPane rows are keyed by
          // bank-ledger UUID (r.id), but link state attaches to the
          // system-side transaction. Match on linkedTransactionId.
          r.linkedTransactionId === transactionId ? { ...r, linkedStagedRowId } : r,
        ),
      );
    },
    [setDbRows],
  );

  const updateDbRowFlag = useCallback(
    (transactionId: number, flag: { kind: string; note: string | null } | null) => {
      setDbRows((rows) =>
        rows.map((r) =>
          r.linkedTransactionId === transactionId ? { ...r, reconciliationFlag: flag } : r,
        ),
      );
    },
    [setDbRows],
  );

  const acceptSuggestion = useCallback(
    async (s: SuggestionDisplay) => {
      const key = `accept:${s.stagedRowId}:${s.transactionId}`;
      const updated = await patchStagedRow(
        s.stagedRowId,
        { reconcileState: "linked", linkedTransactionId: s.transactionId },
        key,
      );
      if (updated) {
        updateDbRowLink(s.transactionId, s.stagedRowId);
      }
    },
    [patchStagedRow, updateDbRowLink],
  );

  const rejectSuggestion = useCallback((s: SuggestionDisplay) => {
    const key = `${s.stagedRowId}:${s.transactionId}`;
    setRejectedSuggestions((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const unlinkStagedRow = useCallback(
    async (rowId: string) => {
      const row = detail?.rows.find((r) => r.id === rowId);
      const prevLinkedTx = row?.linkedTransactionId ?? null;
      const updated = await patchStagedRow(
        rowId,
        { reconcileState: "unmatched", linkedTransactionId: null },
        `unlink:${rowId}`,
      );
      if (updated && prevLinkedTx != null) {
        updateDbRowLink(prevLinkedTx, null);
      }
    },
    [detail, patchStagedRow, updateDbRowLink],
  );

  const skipStagedRow = useCallback(
    async (rowId: string) => {
      await patchStagedRow(
        rowId,
        { reconcileState: "skipped_duplicate" },
        `skip:${rowId}`,
      );
      // Skipping a row removes it from the approve set by default.
      setSelected((s) => {
        const next = new Set(s);
        next.delete(rowId);
        return next;
      });
    },
    [patchStagedRow],
  );

  const unskipStagedRow = useCallback(
    async (rowId: string) => {
      await patchStagedRow(
        rowId,
        { reconcileState: "unmatched" },
        `unskip:${rowId}`,
      );
    },
    [patchStagedRow],
  );

  const beginLink = useCallback((stagedRowId: string) => {
    setLinkMode({ stagedRowId });
  }, []);

  const cancelLink = useCallback(() => {
    setLinkMode(null);
  }, []);

  const completeLink = useCallback(
    async (transactionId: number) => {
      if (!linkMode) return;
      const updated = await patchStagedRow(
        linkMode.stagedRowId,
        { reconcileState: "linked", linkedTransactionId: transactionId },
        `link:${linkMode.stagedRowId}`,
      );
      if (updated) {
        updateDbRowLink(transactionId, linkMode.stagedRowId);
        setLinkMode(null);
      }
    },
    [linkMode, patchStagedRow, updateDbRowLink],
  );

  // ─── Plan #5 Phase 3 — click-to-highlight neighborhoods ──────────────
  // Source of truth for staged↔bank join: each side carries the system
  // transaction id (staged.linkedTransactionId / dbRow.linkedTransactionId)
  // once a link exists. Two staged rows can also be transfer-pair peers
  // WITHIN the same batch via staged.peerStagedId (fans out the highlight
  // to the peer + any bank rows linked to its tx).
  //
  // Pair lineage via system-side linkId/tradeLinkId/swapLinkId is NOT
  // surfaced here — DbTransactionRow doesn't carry those fields and the
  // staged side never does. Matches /reconcile's out-of-scope note about
  // cross-account highlights: keep the wiring honest to the data we have.
  const computeNeighborhoodFromStaged = useCallback(
    (stagedId: string) => {
      const stagedIds = new Set<string>([stagedId]);
      const bankIds = new Set<string>();
      const rows = detail?.rows ?? [];
      const stagedById = new Map(rows.map((r) => [r.id, r]));
      const seed = stagedById.get(stagedId);
      if (!seed) return { stagedIds, bankIds };
      const txIds = new Set<number>();
      if (seed.linkedTransactionId != null) txIds.add(seed.linkedTransactionId);
      // Transfer-pair peer within the same batch.
      if (seed.peerStagedId) {
        const peer = stagedById.get(seed.peerStagedId);
        if (peer) {
          stagedIds.add(peer.id);
          if (peer.linkedTransactionId != null) {
            txIds.add(peer.linkedTransactionId);
          }
        }
      }
      for (const dr of dbRows) {
        if (dr.linkedTransactionId != null && txIds.has(dr.linkedTransactionId)) {
          bankIds.add(dr.id);
        }
      }
      return { stagedIds, bankIds };
    },
    [detail, dbRows],
  );

  const computeNeighborhoodFromBank = useCallback(
    (bankId: string) => {
      const stagedIds = new Set<string>();
      const bankIds = new Set<string>([bankId]);
      const rows = detail?.rows ?? [];
      const stagedById = new Map(rows.map((r) => [r.id, r]));
      const seed = dbRows.find((r) => r.id === bankId);
      if (!seed) return { stagedIds, bankIds };
      const txIds = new Set<number>();
      if (seed.linkedTransactionId != null) txIds.add(seed.linkedTransactionId);
      // Pick up the explicit back-reference set by acceptSuggestion /
      // completeLink — covers the in-flight case where the local row
      // already mirrors the link but the underlying ledger fetch hasn't
      // re-run yet.
      if (seed.linkedStagedRowId) {
        const linked = stagedById.get(seed.linkedStagedRowId);
        if (linked) {
          stagedIds.add(linked.id);
          if (linked.linkedTransactionId != null) {
            txIds.add(linked.linkedTransactionId);
          }
          if (linked.peerStagedId) {
            const peer = stagedById.get(linked.peerStagedId);
            if (peer) {
              stagedIds.add(peer.id);
              if (peer.linkedTransactionId != null) {
                txIds.add(peer.linkedTransactionId);
              }
            }
          }
        }
      }
      for (const sr of rows) {
        if (sr.linkedTransactionId != null && txIds.has(sr.linkedTransactionId)) {
          stagedIds.add(sr.id);
          if (sr.peerStagedId) {
            const peer = stagedById.get(sr.peerStagedId);
            if (peer) stagedIds.add(peer.id);
          }
        }
      }
      // Re-fan to additional bank rows that share any tx we picked up
      // through the staged side (e.g. multiple bank rows linked to the
      // same system tx via primary + extra link types).
      for (const dr of dbRows) {
        if (dr.linkedTransactionId != null && txIds.has(dr.linkedTransactionId)) {
          bankIds.add(dr.id);
        }
      }
      return { stagedIds, bankIds };
    },
    [detail, dbRows],
  );

  const clearHighlight = useCallback(() => {
    setHighlightAnchor(null);
    setHighlightedStagedIds(new Set());
    setHighlightedBankIds(new Set());
  }, []);

  const onStagedRowClick = useCallback(
    (stagedId: string) => {
      const anchorKey = `staged:${stagedId}`;
      if (highlightAnchor === anchorKey) {
        clearHighlight();
        return;
      }
      const { stagedIds, bankIds } = computeNeighborhoodFromStaged(stagedId);
      setHighlightAnchor(anchorKey);
      setHighlightedStagedIds(stagedIds);
      setHighlightedBankIds(bankIds);
    },
    [highlightAnchor, computeNeighborhoodFromStaged, clearHighlight],
  );

  const onDbRowClick = useCallback(
    (bankId: string) => {
      const anchorKey = `bank:${bankId}`;
      if (highlightAnchor === anchorKey) {
        clearHighlight();
        return;
      }
      const { stagedIds, bankIds } = computeNeighborhoodFromBank(bankId);
      setHighlightAnchor(anchorKey);
      setHighlightedStagedIds(stagedIds);
      setHighlightedBankIds(bankIds);
    },
    [highlightAnchor, computeNeighborhoodFromBank, clearHighlight],
  );

  // Drop the highlight whenever the user switches accounts or closes the
  // batch — otherwise stale ids tint rows that aren't even in the current
  // view's row set.
  useEffect(() => {
    clearHighlight();
  }, [accountId, openId, clearHighlight]);

  const flagDbRow = useCallback(
    async (transactionId: number) => {
      setBusyKey(`flag:${transactionId}`);
      try {
        const res = await fetch(
          `/api/transactions/${transactionId}/reconciliation-flag`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ flag_kind: "missing_from_statement" }),
          },
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || "Failed to flag transaction");
        }
        updateDbRowFlag(transactionId, { kind: "missing_from_statement", note: null });
      } catch (e) {
        setToast({
          type: "error",
          msg: e instanceof Error ? e.message : "Failed to flag transaction",
        });
      } finally {
        setBusyKey(null);
      }
    },
    [updateDbRowFlag],
  );

  const unflagDbRow = useCallback(
    async (transactionId: number) => {
      setBusyKey(`unflag:${transactionId}`);
      try {
        const res = await fetch(
          `/api/transactions/${transactionId}/reconciliation-flag`,
          { method: "DELETE" },
        );
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || "Failed to remove flag");
        }
        updateDbRowFlag(transactionId, null);
      } catch (e) {
        setToast({
          type: "error",
          msg: e instanceof Error ? e.message : "Failed to remove flag",
        });
      } finally {
        setBusyKey(null);
      }
    },
    [updateDbRowFlag],
  );

  // Per-row bank-transaction delete on /import/pending (2026-05-27).
  // Same two-phase contract as /reconcile: first POST sends an empty
  // body and the server replies 409 when the row has linked txs; the
  // modal lets the user pick "Delete all" / "Keep tx" / "Cancel".
  const deleteBankRow = useCallback(
    async (bankId: string, deleteLinkedTransactions: boolean | null) => {
      setBusyKey(`bank-delete:${bankId}`);
      try {
        const body: Record<string, unknown> = {};
        if (deleteLinkedTransactions != null) {
          body.deleteLinkedTransactions = deleteLinkedTransactions;
        }
        const res = await fetch(
          `/api/bank-transactions/${encodeURIComponent(bankId)}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (res.status === 409) {
          const payload = await res.json();
          const snap = dbRows.find((r) => r.id === bankId);
          setBankDeleteConfirm({
            bankId,
            date: payload.bankDate ?? snap?.date ?? "",
            amount: payload.bankAmount ?? snap?.amount ?? 0,
            currency: payload.bankCurrency ?? snap?.currency ?? "CAD",
            payee: snap?.payee ?? null,
            linkedTransactionCount: payload.linkedTransactionCount ?? 0,
          });
          return;
        }
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error ?? `HTTP ${res.status}`);
        }
        // Optimistic removal — drop the row from local state. The next
        // full bank-ledger reload (account change or page open) will
        // fetch fresh.
        setDbRows((rows) => rows.filter((r) => r.id !== bankId));
        setBankDeleteConfirm(null);
      } catch (e) {
        setToast({
          type: "error",
          msg: e instanceof Error ? e.message : "Failed to delete bank row",
        });
      } finally {
        setBusyKey(null);
      }
    },
    [dbRows, setDbRows],
  );

  // FINLYNQ-124 — live BANK-ledger staging calc behind ReconciliationCallout.
  // "Send to bank ledger" writes the file's rows ONLY to `bank_transactions`,
  // so the banner projects against the bank-ledger running total (left pane),
  // NOT the system-ledger balance (which duplicated the Reconcile tab and went
  // dead after send).
  //   - bankLedgerBalance = latest-dated dbRows runningBalance (what staged
  //     rows land into).
  //   - sendCount/sendDelta = the rows the Send button will write right now,
  //     tracking the right-pane checkboxes via the same eligibility filter the
  //     old liveProjection + server pendingDelta used (selected, non-existing,
  //     non-skipped_duplicate, non-linked).
  // Synchronous recompute on every `setDbRows` / `setDetail` / `setSelected` —
  // the ≤500ms target is met by virtue of being client-side memoization.
  const bankLedgerCalc = useMemo(() => {
    const bankLedgerBalance = latestBankLedgerBalance(dbRows);
    const { count: sendCount, delta: sendDelta } = sendableDelta(
      detail?.rows ?? [],
      selected,
    );
    return { bankLedgerBalance, sendCount, sendDelta };
  }, [dbRows, detail, selected]);

  // Derive the displayable suggestion cards from the matcher's pairs,
  // filtering out (a) rejected pairs, (b) staged rows already at 'linked'
  // or 'skipped_duplicate', (c) DB rows already linked to a different
  // staged row in this batch. Enriches with decoded payee/date/amount
  // from both sides so the SuggestionsGroup card doesn't need a second
  // lookup pass.
  const displaySuggestions: SuggestionDisplay[] = useMemo(() => {
    if (!detail?.suggestedMatches) return [];
    const stagedById = new Map(detail.rows.map((r) => [r.id, r]));
    // Two-ledger refactor (2026-05-22): DbPane rows are keyed by bank-
    // ledger UUID (r.id). The auto-match suggestion carries the system-
    // side transactionId, so we key the lookup map by linkedTransactionId.
    // Rows without a linked transaction (bank-only history) are skipped.
    const dbByTxId = new Map<number, DbTransactionRow>();
    for (const r of dbRows) {
      if (r.linkedTransactionId != null) dbByTxId.set(r.linkedTransactionId, r);
    }
    const out: SuggestionDisplay[] = [];
    for (const s of detail.suggestedMatches) {
      const key = `${s.stagedRowId}:${s.transactionId}`;
      if (rejectedSuggestions.has(key)) continue;
      const sRow = stagedById.get(s.stagedRowId);
      const dRow = dbByTxId.get(s.transactionId);
      if (!sRow || !dRow) continue;
      if (sRow.reconcileState === "linked" || sRow.reconcileState === "skipped_duplicate") continue;
      if (dRow.linkedStagedRowId != null && dRow.linkedStagedRowId !== sRow.id) continue;
      out.push({
        stagedRowId: s.stagedRowId,
        transactionId: s.transactionId,
        confidence: s.confidence,
        stagedPayee: sRow.payee,
        stagedDate: sRow.date,
        stagedAmount: Number(sRow.amount ?? 0),
        stagedCurrency: sRow.currency ?? "CAD",
        dbPayee: dRow.payee,
        dbDate: dRow.date,
        dbAmount: dRow.amount,
        dbCurrency: dRow.currency,
      });
    }
    return out;
  }, [detail, dbRows, rejectedSuggestions]);

  const approve = useCallback(async () => {
    if (!openId || selected.size === 0) return;
    setActing(true);
    try {
      const res = await fetch(`/api/import/staged/${openId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIds: Array.from(selected) }),
      });
      const data = await res.json();
      if (!res.ok && data?.code === "unresolved_categories") {
        setUnresolved({
          rowIds: Array.isArray(data?.data?.rowIds) ? data.data.rowIds : [],
          payees: Array.isArray(data?.data?.payees) ? data.data.payees : [],
        });
        setToast({
          type: "error",
          msg: `${data?.data?.rowIds?.length ?? 0} row${
            (data?.data?.rowIds?.length ?? 0) === 1 ? "" : "s"
          } need a category before import`,
        });
        return;
      }
      if (!res.ok && data?.code === "bank_ledger_upsert_failed") {
        // Two-ledger refactor — bank_transactions upsert is now fatal.
        // Surface the exact error so the user can report it and we can
        // fix the underlying schema/migration issue.
        setToast({
          type: "error",
          msg: `Bank-ledger write failed: ${data.error ?? "Unknown error"}`,
        });
        return;
      }
      if (!res.ok) throw new Error(data.error || "Approve failed");
      // Phase 3 of import-modes refactor (2026-05-25) — approve writes ONLY to
      // bank_transactions. 2026-06-05 — the sent rows are no longer deleted;
      // they stay on the file (right) side highlighted as "imported". So
      // instead of closing the batch, we stay put and refresh in place:
      //   - reload the staged detail → sent rows show highlighted + drop out
      //     of the (re-seeded) selection;
      //   - reload the bank ledger (left) → sent rows now appear there too;
      //   - refresh the pending list → the batch leaves it once fully sent.
      const approved = data.approved ?? data.imported ?? 0;
      const skipped = data.skippedDuplicates ?? 0;
      setToast({
        type: "success",
        msg: `Sent ${approved} row${approved === 1 ? "" : "s"} to the bank ledger${
          skipped > 0 ? ` (${skipped} duplicate${skipped === 1 ? "" : "s"} skipped)` : ""
        } — marked "imported" below. Open the Reconcile tab to categorize.`,
      });
      loadList();
      reloadBankLedger();
      try {
        const refreshed = await loadDetail(openId);
        setSelected(
          new Set(
            refreshed.rows
              .filter(
                (r) =>
                  !r.isDuplicate &&
                  r.reconcileState !== "skipped_duplicate" &&
                  r.rowStatus !== "approved",
              )
              .map((r) => r.id),
          ),
        );
      } catch {
        /* best-effort — the toast already confirmed the send */
      }
    } catch (e) {
      setToast({ type: "error", msg: e instanceof Error ? e.message : "Approve failed" });
    } finally {
      setActing(false);
    }
  }, [openId, selected, loadList, reloadBankLedger, loadDetail]);

  const refreshDetail = useCallback(async () => {
    if (!openId) return;
    try {
      const res = await fetch(`/api/import/staged/${openId}`);
      const data: StagedDetail = await res.json();
      if (!res.ok) return;
      setDetail(data);
      setUnresolved((prev) => {
        if (!prev) return prev;
        const stillUnresolved = prev.rowIds.filter((rid) => {
          const row = data.rows.find((r) => r.id === rid);
          if (!row) return false;
          return !row.category || row.category.trim() === "";
        });
        if (stillUnresolved.length === 0) return null;
        const filteredPayees = prev.rowIds
          .map((rid, idx) =>
            stillUnresolved.includes(rid) ? prev.payees[idx] : null,
          )
          .filter((p): p is string => p !== null);
        return { rowIds: stillUnresolved, payees: filteredPayees };
      });
    } catch {
      /* best-effort */
    }
  }, [openId, setDetail]);

  // FINLYNQ-88 — manual "Re-apply rules" button. Operates over the whole
  // batch (no per-row scope) so the user can refresh rule effects after
  // editing /settings/rules or after a side-effect rule was added late.
  // Confirmation modal warns about overwriting manual edits — the helper
  // SKIPS reconcile_state IN ('linked', 'skipped_duplicate') rows by
  // construction; everything else gets re-evaluated.
  const reapplyRules = useCallback(async () => {
    if (!openId) return;
    setReapplying(true);
    try {
      const res = await fetch(`/api/import/staged/${openId}/apply-rules`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? "Rule re-apply failed");
      }
      const rowsTouched = data?.data?.rowsTouched ?? 0;
      setToast({
        type: "success",
        msg: `${rowsTouched} row${rowsTouched === 1 ? "" : "s"} updated by rules`,
      });
      setReapplyModalOpen(false);
      // Refetch staged detail so the row table renders the new state
      // (renamed payees, flipped tx_type, target_account_id, etc.). Also
      // shrinks the unresolved-categories banner if rules covered any of
      // the previously-unresolved rows.
      await refreshDetail();
    } catch (e) {
      setToast({
        type: "error",
        msg: e instanceof Error ? e.message : "Rule re-apply failed",
      });
    } finally {
      setReapplying(false);
    }
  }, [openId, refreshDetail]);

  const reject = useCallback(async () => {
    if (!openId) return;
    if (!confirm("Discard this staged import? The rows will be deleted.")) return;
    setActing(true);
    try {
      const res = await fetch(`/api/import/staged/${openId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Reject failed");
      setToast({ type: "success", msg: "Staged import discarded" });
      closeDetail();
      loadList();
    } catch (e) {
      setToast({ type: "error", msg: e instanceof Error ? e.message : "Reject failed" });
    } finally {
      setActing(false);
    }
  }, [openId, closeDetail, loadList]);

  // ─── Render ────────────────────────────────────────────────────────────

  // List view — no open batch.
  if (!openId) {
    // Embedded surface: scope the list to the selected account (route mode
    // shows every pending batch across accounts, plus still-unbound ones).
    // boundAccountId now rides on the list payload, so no per-batch detail
    // fetch is needed (this replaces the old inbox N+1 binding-resolution).
    const visibleList =
      embedded && accountScope != null && list
        ? list.filter((r) => (r.boundAccountId ?? null) === accountScope)
        : list;
    return (
      <StagedListView
        list={visibleList}
        loading={loading}
        error={error}
        toast={toast}
        loadList={loadList}
        openDetail={openDetail}
        embedded={embedded}
        accountScope={accountScope}
        // Clicking a loaded batch re-opens the SAME staging two-pane review for
        // its source import (the imported rows persist there, highlighted) —
        // not a separate view. Null = simplified/auto batch with no staged
        // detail to open.
        onOpenLoadedBatch={(stagedImportId) => {
          if (stagedImportId) {
            void openDetail(stagedImportId);
          } else {
            setToast({
              type: "error",
              msg: "This import was loaded directly to the bank ledger — open the Reconcile tab to see its rows.",
            });
          }
        }}
      />
    );
  }

  // Two-pane reconciliation view — batch open.
  return (
    <div className="space-y-4 flex flex-col h-[calc(100vh-8rem)]">
      <ReconcileHeader
        detail={detail}
        accountId={accountId}
        acting={acting}
        reapplying={reapplying}
        selectedCount={selected.size}
        reapplyModalOpen={reapplyModalOpen}
        setReapplyModalOpen={setReapplyModalOpen}
        closeDetail={closeDetail}
        reapplyRules={reapplyRules}
        reject={reject}
        approve={approve}
      />

      {toast && (
        <Card
          className={
            toast.type === "success"
              ? "border-emerald-200 bg-emerald-50/30"
              : "border-rose-200 bg-rose-50/30"
          }
        >
          <CardContent className="py-3 text-sm">{toast.msg}</CardContent>
        </Card>
      )}

      {detail && detail.staged.statementBalance != null && (
        <ReconciliationCallout
          statementBalance={detail.staged.statementBalance ?? null}
          statementBalanceDate={detail.staged.statementBalanceDate ?? null}
          statementCurrency={detail.staged.statementCurrency ?? null}
          boundAccountId={detail.staged.boundAccountId ?? null}
          bankLedgerBalance={bankLedgerCalc.bankLedgerBalance}
          sendCount={bankLedgerCalc.sendCount}
          sendDelta={bankLedgerCalc.sendDelta}
          boundAccountCurrency={detail.reconciliation?.boundAccountCurrency ?? null}
        />
      )}

      {detail && (detail.balanceWarnings?.length ?? 0) > 0 && (
        <BalanceWarningBanner
          warnings={detail.balanceWarnings ?? []}
          currency={
            detail.staged.statementCurrency ??
            detail.reconciliation?.boundAccountCurrency ??
            null
          }
        />
      )}

      {/* Existing bank-ledger drift — the SAME rich banner as the staged-file
          check, shown only when the staged file itself produced no balance
          warnings (so an active import with its own anchors doesn't render a
          duplicate banner). Restores the pre-consolidation rich balance view
          for files that carry no Balance column of their own. */}
      {detail &&
        (detail.balanceWarnings?.length ?? 0) === 0 &&
        bankLedgerWarnings.length > 0 && (
          <BalanceWarningBanner
            warnings={bankLedgerWarnings}
            currency={driftCurrency}
          />
        )}

      {anchorsOnlyHint && (
        <Card className="border-sky-300 bg-sky-50/50">
          <CardContent className="py-2.5 px-3 text-sm flex items-start gap-3">
            <Info className="h-4 w-4 text-sky-700 shrink-0 mt-0.5" />
            <div className="text-sky-900">
              All {anchorsOnlyHint.totalRows} transaction
              {anchorsOnlyHint.totalRows === 1 ? "" : "s"} in this file are
              already in the bank ledger. Clicking <strong>Approve</strong> will
              still load{" "}
              <strong>
                {anchorsOnlyHint.anchorCount} balance anchor
                {anchorsOnlyHint.anchorCount === 1 ? "" : "s"}
              </strong>{" "}
              from this file into the bank-side ledger.
            </div>
          </CardContent>
        </Card>
      )}

      {detail && unresolved && unresolved.rowIds.length > 0 && (
        <UnresolvedCategoriesBanner
          stagedImportId={detail.staged.id}
          rowIds={unresolved.rowIds}
          payees={unresolved.payees}
          onRuleApplied={refreshDetail}
          onDismiss={() => setUnresolved(null)}
        />
      )}

      {detail && accountOptions.length > 0 && (
        <AccountSelector
          options={accountOptions}
          value={accountId}
          onChange={setAccountId}
        />
      )}

      {linkMode && (
        <Card className="border-sky-300 bg-sky-50/50">
          <CardContent className="py-2 px-3 text-sm flex items-center justify-between gap-3">
            <span>
              <LinkIcon className="h-3.5 w-3.5 inline mr-1.5" />
              Pick a transaction on the left pane to link to staged row{" "}
              <span className="font-mono">
                #{detail?.rows.find((r) => r.id === linkMode.stagedRowId)?.rowIndex ?? "?"}
              </span>
            </span>
            <Button size="sm" variant="ghost" onClick={cancelLink}>
              <XIcon className="h-3.5 w-3.5 mr-1" />
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex-1 min-h-0">
        {detailLoading ? (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground text-center">
              Loading rows…
            </CardContent>
          </Card>
        ) : detail && detail.pickerCandidates && detail.staged.headers ? (
          // 2026-05-28 — Unbound email-import path: CSV didn't template-match
          // at parse time so per-account split would be empty. Render the
          // template/account picker INSTEAD of the panes; on bind, reload
          // detail and the panes render normally with populated account_name.
          <UnboundPickerPane
            detail={detail as StagedDetail & { pickerCandidates: NonNullable<StagedDetail["pickerCandidates"]> }}
            openId={openId}
            setDetail={setDetail}
            setDetailLoading={setDetailLoading}
          />
        ) : detail ? (
          <TwoPaneLayout
            leftLabel="Bank ledger (continuous)"
            left={
              <BankPane
                dbRows={dbRows}
                dbRowsLoading={dbRowsLoading}
                onDbRowClick={onDbRowClick}
                highlightedBankIds={highlightedBankIds}
                linkMode={linkMode}
                busyKey={busyKey}
                deleteBankRow={deleteBankRow}
                completeLink={completeLink}
                flagDbRow={flagDbRow}
                unflagDbRow={unflagDbRow}
              />
            }
            rightLabel="From the file (staged)"
            right={
              <StagedPane
                stagedImportId={detail.staged.id}
                rows={filteredStagedRows}
                selected={selected}
                expanded={expandedRows}
                accounts={accounts}
                holdings={holdings}
                onToggleSelect={toggleSelect}
                onToggleExpand={toggleExpanded}
                onRowUpdated={onRowUpdated}
                onStagedRowClick={onStagedRowClick}
                highlightedStagedIds={highlightedStagedIds}
                anchorsByDate={stagedAnchorsByDate}
                displaySuggestions={displaySuggestions}
                acceptSuggestion={acceptSuggestion}
                rejectSuggestion={rejectSuggestion}
                busyKey={busyKey}
                linkMode={linkMode}
                beginLink={beginLink}
                skipStagedRow={skipStagedRow}
                unskipStagedRow={unskipStagedRow}
                unlinkStagedRow={unlinkStagedRow}
              />
            }
          />
        ) : null}
      </div>

      {/* Confirmation modal for per-row bank-transaction delete (2026-05-27). */}
      {bankDeleteConfirm && (
        <ConfirmDeleteBankRow
          open
          linkedTransactionCount={bankDeleteConfirm.linkedTransactionCount}
          bankDate={bankDeleteConfirm.date}
          bankAmount={bankDeleteConfirm.amount}
          bankCurrency={bankDeleteConfirm.currency}
          bankPayee={bankDeleteConfirm.payee}
          busy={busyKey === `bank-delete:${bankDeleteConfirm.bankId}`}
          onConfirm={(deleteLinked) => {
            void deleteBankRow(bankDeleteConfirm.bankId, deleteLinked);
          }}
          onCancel={() => setBankDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
