"use client";

/**
 * /import/pending — review queue for staged imports.
 *
 * Two modes:
 *   - List view (openId == null): shows pending batches; click to open.
 *   - Two-pane reconciliation view (openId != null): full-page surface
 *     with AccountSelector + DbPane (left) + FilePane (right) plus the
 *     existing ReconciliationCallout + UnresolvedCategoriesBanner +
 *     Approve/Discard footer.
 *
 * URL state: `?id=<batchId>&account=<accountId>`. Both update via
 * history.replaceState so tab close + reopen restores state.
 *
 * Rebuilt in Phase 2 of FINLYNQ-56. Phase 3 will wire the four match
 * actions (auto-match accept, manual link/unlink, skip, flag-missing)
 * on top of this scaffold.
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ArrowRight,
  Inbox,
  Mail,
  Upload,
  Clock,
  Check,
  X,
  RefreshCw,
  Info,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sparkles } from "lucide-react";
import { ReconciliationCallout } from "@/components/staging/reconciliation-callout";
import {
  type StagedEditableRow,
  type AccountOption as EditorAccountOption,
  type HoldingOption,
} from "@/components/staging/staged-row-editor";
import { UnresolvedCategoriesBanner } from "@/components/staging/unresolved-categories-banner";
import {
  BalanceWarningBanner,
  type BalanceWarning,
} from "@/components/staging/balance-warning-banner";
import { AccountSelector, type AccountOption } from "@/components/import/reconcile/account-selector";
import { TwoPaneLayout } from "@/components/import/reconcile/two-pane-layout";
import { safeName } from "@/lib/safe-name";
import { FilePane } from "@/components/import/reconcile/file-pane";
import { DbPane, type DbTransactionRow } from "@/components/import/reconcile/db-pane";
import {
  UnboundImportPicker,
  type PickerAccount,
  type PickerTemplate,
} from "@/components/staging/unbound-import-picker";
import {
  SuggestionsGroup,
  type SuggestionDisplay,
} from "@/components/import/reconcile/suggestions-group";
import { ConfirmDeleteBankRow } from "@/components/reconcile/confirm-delete-bank-row";
import { Link as LinkIcon, Flag, X as XIcon, Trash2 } from "lucide-react";

interface StagedRow {
  id: string;
  source: string;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string;
  totalRowCount: number;
  duplicateCount: number;
  expiresAt: string;
  originalFilename?: string | null;
  fileFormat?: string | null;
}

interface ParsedAnchorRow {
  date: string;
  balance: number;
  currency?: string;
  source?: string;
}

interface StagedDetail {
  staged: StagedRow & {
    status: string;
    originalFilename?: string | null;
    fileFormat?: string | null;
    statementBalance?: number | null;
    statementBalanceDate?: string | null;
    statementCurrency?: string | null;
    boundAccountId?: number | null;
    dateRangeStart?: string | null;
    dateRangeEnd?: string | null;
    /** 2026-05-24 — anchors parsed from the file's Balance column.
     *  Same shape persisted to staged_imports.parsed_anchors. */
    parsedAnchors?: ParsedAnchorRow[] | null;
    /** 2026-05-28 — fallback metadata captured when an email-import CSV
     *  attachment didn't template-match at parse time. Backs the
     *  UnboundImportPicker. Both null for upload-path imports and for
     *  email imports whose CSV did match a template. */
    headers?: string[] | null;
    sampleRows?: Array<Record<string, string>> | null;
  };
  rows: StagedEditableRow[];
  reconciliation?: {
    currentBalance: number | null;
    projectedBalance: number | null;
    pendingDelta: number | null;
    boundAccountCurrency: string | null;
  };
  suggestedMatches?: Array<{
    stagedRowId: string;
    transactionId: number;
    confidence: "exact" | "fuzzy";
  }>;
  /** 2026-05-24 — bank balance pre-flight mismatches. Empty array =
   *  every anchor in the batch lines up with the running total. */
  balanceWarnings?: BalanceWarning[];
  /** 2026-05-28 — populated by the GET when bound_account_id IS NULL AND
   *  headers IS NOT NULL. Lets the UnboundImportPicker render template
   *  + account dropdowns without extra round-trips. */
  pickerCandidates?: {
    accounts: PickerAccount[];
    templates: PickerTemplate[];
  } | null;
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/** Shift a YYYY-MM-DD by N days (positive or negative). */
function shiftDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

export default function PendingImportsPage() {
  return (
    <Suspense fallback={null}>
      <PendingImportsPageInner />
    </Suspense>
  );
}

function PendingImportsPageInner() {
  const [list, setList] = useState<StagedRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StagedDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [accounts, setAccounts] = useState<EditorAccountOption[]>([]);
  const [holdings, setHoldings] = useState<HoldingOption[]>([]);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [unresolved, setUnresolved] = useState<{ rowIds: string[]; payees: string[] } | null>(null);
  // FINLYNQ-56 — two-pane state.
  const [accountId, setAccountId] = useState<number | null>(null);
  const [dbRows, setDbRows] = useState<DbTransactionRow[]>([]);
  const [dbRowsLoading, setDbRowsLoading] = useState(false);
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

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/import/staged");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setList(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const openDetail = useCallback(async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setDetailLoading(true);
    setExpandedRows(new Set());
    try {
      const [detailRes, acctRes, holdRes] = await Promise.all([
        fetch(`/api/import/staged/${id}`),
        fetch("/api/accounts"),
        fetch("/api/portfolio"),
      ]);
      const data: StagedDetail = await detailRes.json();
      if (!detailRes.ok) {
        throw new Error((data as unknown as { error?: string }).error || "Failed to load");
      }
      setDetail(data);
      setSelected(
        new Set(
          data.rows
            .filter((r) => !r.isDuplicate && r.reconcileState !== "skipped_duplicate")
            .map((r) => r.id),
        ),
      );
      if (acctRes.ok) {
        const acctRaw = (await acctRes.json()) as Array<{
          id: number;
          name: string | null;
          currency: string;
          isInvestment?: boolean;
        }>;
        setAccounts(
          acctRaw
            .filter((a) => a.name != null)
            .map((a) => ({
              id: a.id,
              name: a.name as string,
              currency: a.currency,
              isInvestment: Boolean(a.isInvestment),
            })),
        );
      }
      if (holdRes.ok) {
        const holdRaw = (await holdRes.json()) as Array<{
          id: number;
          name: string | null;
          symbol: string | null;
          accountId: number | null;
          currency: string;
        }>;
        setHoldings(
          holdRaw
            .filter((h) => h.name != null)
            .map((h) => ({
              id: h.id,
              name: h.name as string,
              symbol: h.symbol,
              accountId: h.accountId,
              currency: h.currency,
            })),
        );
      }
    } catch (e) {
      setToast({ type: "error", msg: e instanceof Error ? e.message : "Failed to load" });
      setOpenId(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setOpenId(null);
    setDetail(null);
    setSelected(new Set());
    setExpandedRows(new Set());
    setUnresolved(null);
    setAccountId(null);
    setDbRows([]);
    // Clear ?id= and ?account= from URL when returning to the list.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("id");
      url.searchParams.delete("account");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  const searchParams = useSearchParams();
  useEffect(() => {
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
    const fromUrl = searchParams?.get("account");
    const parsed = fromUrl ? parseInt(fromUrl, 10) : NaN;
    const fromUrlIsValid =
      Number.isFinite(parsed) && accountOptions.some((o) => o.id === parsed);
    const next = fromUrlIsValid ? parsed : accountOptions[0].id;
    if (next !== accountId) {
      setAccountId(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, accountOptions]);

  // Persist accountId into the URL on every change (history.replaceState
  // so back/forward isn't polluted with intra-page transitions).
  useEffect(() => {
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
  }, [openId, accountId]);

  // dbWindow was the ±7d date window used by the previous reconciliation
  // endpoint (transactions). The bank-ledger endpoint shows the full
  // continuous history per account — the window is no longer needed.
  // shiftDays is still imported for any future date-arithmetic; keeping
  // the helper alive avoids an unused-import warning.
  void shiftDays;

  // Fetch the bank-side ledger for the selected account whenever the
  // selection changes. Two-ledger refactor (2026-05-22): the left pane
  // now shows the continuous `bank_transactions` history (no date
  // window) — previously this fetched live `transactions` rows in a
  // ±7d window via /api/transactions/reconciliation. The window param
  // is dropped; the bank ledger is the truthful "continuous statement
  // from the bank side" view per the refactor.
  useEffect(() => {
    if (!accountId) {
      setDbRows([]);
      return;
    }
    let cancelled = false;
    setDbRowsLoading(true);
    const params = new URLSearchParams({
      accountId: String(accountId),
    });
    fetch(`/api/import/bank-ledger?${params.toString()}`)
      .then((res) =>
        res.json().then((data) => ({ ok: res.ok, status: res.status, data })),
      )
      .then(({ ok, status, data }) => {
        if (cancelled) return;
        if (!ok) {
          const msg =
            status === 423
              ? data?.message ||
                "Your session needs to be unlocked. Reload and sign in again."
              : data?.error || "Failed to load bank ledger";
          setToast({ type: "error", msg });
          setDbRows([]);
          return;
        }
        setDbRows(Array.isArray(data?.data?.transactions) ? data.data.transactions : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setToast({
          type: "error",
          msg: e instanceof Error ? e.message : "Failed to load",
        });
        setDbRows([]);
      })
      .finally(() => {
        if (cancelled) return;
        setDbRowsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

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
  }, []);

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
    [openId],
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
    [],
  );

  const updateDbRowFlag = useCallback(
    (transactionId: number, flag: { kind: string; note: string | null } | null) => {
      setDbRows((rows) =>
        rows.map((r) =>
          r.linkedTransactionId === transactionId ? { ...r, reconciliationFlag: flag } : r,
        ),
      );
    },
    [],
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
    [dbRows],
  );

  // FINLYNQ-56 Phase 4 — live "After approval" balance. The projection
  // sums selected rows that will actually materialize into `transactions`
  // on approve:
  //   - SELECTED       (user checked it on the right pane)
  //   - dedupStatus != 'existing'   (existing rows are already in the balance)
  //   - reconcileState != 'linked'         (linked rows don't materialize — the
  //                                         target tx is already in the balance)
  //   - reconcileState != 'skipped_duplicate' (already-imported marker)
  // Synchronous recompute on every `setDetail` / `setSelected` — the
  // ≤500ms target is met by virtue of being client-side memoization.
  const liveProjection = useMemo(() => {
    if (!detail) return null;
    const recon = detail.reconciliation;
    const current = recon?.currentBalance ?? null;
    if (current == null) return { current: null, projected: null };
    const liveDelta = detail.rows
      .filter(
        (r) =>
          selected.has(r.id) &&
          r.dedupStatus !== "existing" &&
          r.reconcileState !== "skipped_duplicate" &&
          r.reconcileState !== "linked",
      )
      .reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
    return { current, projected: current + liveDelta };
  }, [detail, selected]);

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
    const dbByTxId = new Map<number, typeof dbRows[number]>();
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
      // Phase 3 of import-modes refactor (2026-05-25) — approve now writes
      // ONLY to bank_transactions. The user goes to /reconcile to
      // categorize + materialize into the ledger.
      const approved = data.approved ?? data.imported ?? 0;
      const skipped = data.skippedDuplicates ?? 0;
      setToast({
        type: "success",
        msg: `Sent ${approved} row${approved === 1 ? "" : "s"} to the bank ledger${
          skipped > 0 ? ` (${skipped} duplicate${skipped === 1 ? "" : "s"} skipped)` : ""
        }. Open /reconcile to categorize.`,
      });
      closeDetail();
      loadList();
    } catch (e) {
      setToast({ type: "error", msg: e instanceof Error ? e.message : "Approve failed" });
    } finally {
      setActing(false);
    }
  }, [openId, selected, closeDetail, loadList]);

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
  }, [openId]);

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
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link
            href="/import"
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Import
          </Link>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Pending Imports</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Transactions from email forwards or file uploads (CSV / OFX /
              QFX), waiting for your review. Rows auto-expire after 60 days.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={loadList} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

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

        {error && (
          <Card className="border-rose-200 bg-rose-50/30">
            <CardContent className="py-3 text-sm text-rose-700">{error}</CardContent>
          </Card>
        )}

        {loading && !list && (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground text-center">
              Loading…
            </CardContent>
          </Card>
        )}

        {list && list.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center space-y-3">
              <Inbox className="h-10 w-10 text-muted-foreground mx-auto" />
              <div>
                <p className="text-sm font-medium">Nothing pending</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Upload a CSV/OFX/QFX statement at{" "}
                  <Link href="/import/reconcile" className="underline">
                    Import → Reconciliation
                  </Link>
                  , or forward a bank statement to your import address — both
                  land here for review.
                </p>
              </div>
              <Link href="/import" className="inline-block">
                <Button variant="outline" size="sm">
                  View import options
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {list && list.length > 0 && (
          <div className="space-y-3">
            {list.map((row) => {
              const isUpload = row.source === "upload";
              const Icon = isUpload ? Upload : Mail;
              const headline = isUpload
                ? row.originalFilename || "Uploaded file"
                : row.subject || "(no subject)";
              const subline = isUpload
                ? `${(row.fileFormat ?? "file").toUpperCase()} upload · ${new Date(
                    row.receivedAt,
                  ).toLocaleString()}`
                : `from ${row.fromAddress || "(unknown)"} · received ${new Date(
                    row.receivedAt,
                  ).toLocaleString()}`;
              return (
                <Card
                  key={row.id}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => openDetail(row.id)}
                >
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                          <p className="text-sm font-medium truncate">{headline}</p>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{subline}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="outline" className="font-mono">
                          {row.totalRowCount} {row.totalRowCount === 1 ? "row" : "rows"}
                        </Badge>
                        {row.duplicateCount > 0 && (
                          <Badge
                            variant="outline"
                            className="bg-amber-50 text-amber-700 border-amber-200"
                          >
                            {row.duplicateCount} dupe{row.duplicateCount === 1 ? "" : "s"}
                          </Badge>
                        )}
                        <Badge variant="outline" className="bg-muted/60 text-xs">
                          <Clock className="h-3 w-3 mr-1" />
                          {daysUntil(row.expiresAt)}d left
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Two-pane reconciliation view — batch open.
  return (
    <div className="space-y-4 flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={closeDetail}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Pending Imports
          </button>
          <h1 className="text-xl font-semibold tracking-tight">
            {detail
              ? detail.staged.source === "upload"
                ? detail.staged.originalFilename || "Uploaded file"
                : detail.staged.subject || "(no subject)"
              : "Loading…"}
          </h1>
          {detail && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {detail.staged.source === "upload" && detail.staged.fileFormat
                ? `${detail.staged.fileFormat.toUpperCase()} upload`
                : `From ${detail.staged.fromAddress || "(unknown)"}`}
              {" · "}
              {detail.rows.length} {detail.rows.length === 1 ? "row" : "rows"}
              {detail.staged.dateRangeStart && detail.staged.dateRangeEnd && (
                <>
                  {" · "}
                  {detail.staged.dateRangeStart} → {detail.staged.dateRangeEnd}
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Link
            href={
              accountId != null
                ? `/reconcile?account=${accountId}`
                : "/reconcile"
            }
            className={buttonVariants({ variant: "outline" })}
          >
            Open reconciliation
            <ArrowRight className="h-4 w-4 ml-1.5" />
          </Link>
          <Button
            variant="outline"
            onClick={() => setReapplyModalOpen(true)}
            disabled={acting || reapplying}
            title="Re-apply all active rules over every row in this batch"
          >
            <Sparkles className="h-4 w-4 mr-1.5" />
            Re-apply rules
          </Button>
          <Button
            variant="ghost"
            onClick={reject}
            disabled={acting}
            className="text-rose-700 hover:text-rose-800 hover:bg-rose-50"
          >
            <X className="h-4 w-4 mr-1.5" />
            Discard all
          </Button>
          <Button onClick={approve} disabled={acting || selected.size === 0}>
            <Check className="h-4 w-4 mr-1.5" />
            Send to bank ledger {selected.size > 0 && `(${selected.size})`}
          </Button>
        </div>
      </div>

      {/* FINLYNQ-88 — Re-apply rules confirmation modal. */}
      <Dialog open={reapplyModalOpen} onOpenChange={setReapplyModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Re-apply rules?</DialogTitle>
            <DialogDescription className="space-y-3 pt-2">
              <span className="block">
                This re-applies all active rules to every row in this batch. It
                may overwrite manual edits to payee, category, tags, type, or
                account on matched rows.
              </span>
              <span className="block">
                Rows you&apos;ve already linked to existing transactions and
                rows marked as duplicates are skipped.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setReapplyModalOpen(false)}
              disabled={reapplying}
            >
              Cancel
            </Button>
            <Button onClick={reapplyRules} disabled={reapplying}>
              <Sparkles className="h-4 w-4 mr-1.5" />
              {reapplying ? "Re-applying…" : "Re-apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          currentBalance={liveProjection?.current ?? null}
          projectedBalance={liveProjection?.projected ?? null}
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
          <UnboundImportPicker
            stagedImportId={detail.staged.id}
            headers={detail.staged.headers}
            sampleRows={detail.staged.sampleRows ?? []}
            accounts={detail.pickerCandidates.accounts}
            templates={detail.pickerCandidates.templates}
            fromAddress={detail.staged.fromAddress ?? null}
            subject={detail.staged.subject ?? null}
            totalRowCount={detail.staged.totalRowCount ?? detail.rows.length}
            onBound={async () => {
              // Reload detail so the picker disappears (server stops
              // sending pickerCandidates after boundAccountId is set)
              // and the panes render with the now-bound rows.
              if (openId) {
                setDetailLoading(true);
                try {
                  const resp = await fetch(`/api/import/staged/${openId}`);
                  if (resp.ok) {
                    const data = await resp.json();
                    setDetail(data);
                  }
                } finally {
                  setDetailLoading(false);
                }
              }
            }}
          />
        ) : detail ? (
          <TwoPaneLayout
            leftLabel="Bank ledger (continuous)"
            left={
              <DbPane
                rows={dbRows}
                loading={dbRowsLoading}
                onRowClick={onDbRowClick}
                highlightedBankIds={highlightedBankIds}
                rowActions={(r) => {
                  // In link-mode: show a Pick button on rows that aren't
                  // already linked to a DIFFERENT staged row. The staged
                  // row being linked may itself already be the back-ref
                  // (re-linking), which we allow.
                  const eligibleForLink =
                    !r.linkedStagedRowId ||
                    r.linkedStagedRowId === linkMode?.stagedRowId;
                  const linkBusy = busyKey === `link:${linkMode?.stagedRowId}`;
                  // Two-ledger refactor (2026-05-22): link / flag actions
                  // target the system-side transaction. Bank-only rows
                  // (linkedTransactionId == null) can't be linked / flagged
                  // — they're historical bank entries without a current
                  // system-side row.
                  const txId = r.linkedTransactionId;
                  const deleteBusy = busyKey === `bank-delete:${r.id}`;
                  // Per-row bank delete (2026-05-27) — always available
                  // alongside the link/flag affordances.
                  const deleteBtn = (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void deleteBankRow(r.id, null)}
                      disabled={deleteBusy}
                      title="Delete this bank-ledger row"
                      aria-label="Delete bank row"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  );
                  if (linkMode) {
                    if (!eligibleForLink) {
                      return (
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-[10px] text-muted-foreground italic">
                            already linked
                          </span>
                          {deleteBtn}
                        </div>
                      );
                    }
                    if (txId == null) {
                      return (
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-[10px] text-muted-foreground italic">
                            bank-only
                          </span>
                          {deleteBtn}
                        </div>
                      );
                    }
                    return (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => completeLink(txId)}
                          disabled={linkBusy}
                          className="h-7 px-2"
                        >
                          <Check className="h-3.5 w-3.5 mr-1" />
                          Pick
                        </Button>
                        {deleteBtn}
                      </div>
                    );
                  }
                  if (txId == null) {
                    // Bank-only history row — flag actions don't apply,
                    // but delete still does.
                    return (
                      <div className="flex items-center justify-end gap-1">
                        {deleteBtn}
                      </div>
                    );
                  }
                  // Default mode: flag / unflag toggle + delete.
                  const flagBusy =
                    busyKey === `flag:${txId}` || busyKey === `unflag:${txId}`;
                  if (r.reconciliationFlag) {
                    return (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => unflagDbRow(txId)}
                          disabled={flagBusy}
                          className="h-7 px-2 text-rose-700"
                          title="Remove 'missing from statement' flag"
                        >
                          <XIcon className="h-3.5 w-3.5" />
                        </Button>
                        {deleteBtn}
                      </div>
                    );
                  }
                  return (
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => flagDbRow(txId)}
                        disabled={flagBusy}
                        className="h-7 px-2 text-muted-foreground hover:text-rose-700"
                        title="Mark as missing from this statement"
                      >
                        <Flag className="h-3.5 w-3.5" />
                      </Button>
                      {deleteBtn}
                    </div>
                  );
                }}
              />
            }
            rightLabel="From the file (staged)"
            right={
              <FilePane
                stagedImportId={detail.staged.id}
                rows={filteredStagedRows}
                selected={selected}
                expanded={expandedRows}
                accounts={accounts}
                holdings={holdings}
                onToggleSelect={toggleSelect}
                onToggleExpand={toggleExpanded}
                onRowUpdated={onRowUpdated}
                onRowClick={onStagedRowClick}
                highlightedStagedIds={highlightedStagedIds}
                anchorsByDate={stagedAnchorsByDate}
                header={
                  displaySuggestions.length > 0 && (
                    <SuggestionsGroup
                      suggestions={displaySuggestions}
                      onAccept={acceptSuggestion}
                      onReject={rejectSuggestion}
                      busyId={
                        busyKey?.startsWith("accept:")
                          ? busyKey.replace(/^accept:/, "")
                          : null
                      }
                    />
                  )
                }
                rowActions={(r) => {
                  const linkBusy = busyKey === `link:${r.id}`;
                  const skipBusy =
                    busyKey === `skip:${r.id}` || busyKey === `unskip:${r.id}`;
                  const unlinkBusy = busyKey === `unlink:${r.id}`;
                  if (r.reconcileState === "linked") {
                    return (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => unlinkStagedRow(r.id)}
                        disabled={unlinkBusy}
                        className="h-7 px-2 text-muted-foreground"
                        title="Unlink"
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </Button>
                    );
                  }
                  if (r.reconcileState === "skipped_duplicate") {
                    return (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => unskipStagedRow(r.id)}
                        disabled={skipBusy}
                        className="h-7 px-2 text-muted-foreground"
                        title="Un-skip"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    );
                  }
                  // Default state — show Link + Skip.
                  return (
                    <div className="flex items-center gap-1 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => beginLink(r.id)}
                        disabled={linkBusy || linkMode != null}
                        className="h-7 px-2"
                        title="Link to a DB row"
                      >
                        <LinkIcon className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => skipStagedRow(r.id)}
                        disabled={skipBusy}
                        className="h-7 px-2 text-muted-foreground"
                        title="Mark as already imported"
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                }}
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
