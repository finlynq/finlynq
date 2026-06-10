// Pure selectors + metadata for the account-anchored reconcile inbox.
//
// Mirrors the web inbox tab components (src/components/inbox/*) so the mobile
// card lenses split the /api/reconcile/suggestions snapshot the same way the
// web does. Kept side-effect-free so the tab-filter logic is unit-testable
// without a render harness (see __tests__/inbox.test.ts).

import type {
  AccountMode,
  ReconcileBankSnapshot,
  ReconcileLink,
  ReconcileSuggestions,
  ReconcileTxSnapshot,
} from "../../../shared/types";
import type { IconName } from "../components/icon";
import { safeAccountName } from "../lib/format";

/** Per-bank-row suggestion the RowCard renders. Either a match against an
 *  existing tx, a rule-engine "create as <category>" proposal, or a
 *  transfer-only rule "transfer to <account>" proposal (FINLYNQ-126). */
export type CardSuggestion =
  | {
      kind: "match";
      transactionId: number;
      txPayee: string | null;
      txCategoryName: string | null;
    }
  | { kind: "create"; categoryId: number; categoryName: string }
  | { kind: "transfer"; destAccountId: number; destAccountName: string };

/** Minimal account shape `buildSuggestionByBank` needs to resolve + label a
 *  transfer suggestion's destination account. */
export interface SuggestionAccount {
  id: number;
  name?: string | null;
  alias?: string | null;
  isInvestment?: boolean;
}

/** A pre-existing UNLINKED ledger transaction this bank row appears to
 *  duplicate. When present the RowCard warns + offers "Link to existing"
 *  instead of a one-tap approve that would mint a second ledger entry.
 *  Mirrors web RowCardDuplicate (src/components/inbox/row-card.tsx). */
export interface CardDuplicate {
  transactionId: number;
  txPayee: string | null;
  txDate: string;
  txAmount: number;
  txCurrency: string;
}

export interface ReconciledRow {
  link: ReconcileLink;
  bank: ReconcileBankSnapshot;
  tx: ReconcileTxSnapshot;
}

/**
 * Bank rows with no `transaction_bank_links` entry, newest-first. These are
 * the To-approve (Approve-each) / To-categorize (Auto-pilot) cards.
 */
export function unlinkedBankRows(
  snap: ReconcileSuggestions | null,
): ReconcileBankSnapshot[] {
  if (!snap) return [];
  const linked = new Set(snap.linked.map((l) => l.bankTransactionId));
  return Object.values(snap.bankTransactions)
    .filter((b) => !linked.has(b.id))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Already-reconciled (bank ↔ tx) rows, newest-first. Drops links whose bank
 *  or tx snapshot is missing (defensive). */
export function reconciledRows(
  snap: ReconcileSuggestions | null,
): ReconciledRow[] {
  if (!snap) return [];
  return snap.linked
    .map((link) => {
      const bank = snap.bankTransactions[link.bankTransactionId];
      const tx = snap.transactions[link.transactionId];
      if (!bank || !tx) return null;
      return { link, bank, tx };
    })
    .filter((r): r is ReconciledRow => r !== null)
    .sort((a, b) => b.bank.date.localeCompare(a.bank.date));
}

/**
 * Build the per-bank-row suggestion map for the card UI. A match against an
 * existing tx wins; otherwise fall back to the rule-engine's
 * `suggestedCategoryId`; and finally — when `opts.includeTransfers` is set and
 * `opts.accounts` is supplied — a transfer-only rule's
 * `suggestedTransferAccountId`. Category wins over transfer when both exist.
 * Mirrors web InboxToApproveTab.suggestionByBank (FINLYNQ-126).
 */
export function buildSuggestionByBank(
  snap: ReconcileSuggestions | null,
  categoryName: (id: number) => string,
  opts?: { accounts?: SuggestionAccount[]; includeTransfers?: boolean },
): Map<string, CardSuggestion> {
  const map = new Map<string, CardSuggestion>();
  if (!snap) return map;
  // 1) Match against an existing tx — preferred over create.
  for (const s of snap.suggestions) {
    if (map.has(s.bankTransactionId)) continue;
    const tx = snap.transactions[s.transactionId];
    if (!tx) continue;
    map.set(s.bankTransactionId, {
      kind: "match",
      transactionId: s.transactionId,
      txPayee: tx.payee,
      txCategoryName: tx.categoryName,
    });
  }
  // 2) Fallback: the match-engine's suggestedCategoryId (category wins over
  //    transfer). 3) Then a transfer-only rule's suggestedTransferAccountId.
  for (const b of Object.values(snap.bankTransactions)) {
    if (map.has(b.id)) continue;
    if (b.suggestedCategoryId != null) {
      map.set(b.id, {
        kind: "create",
        categoryId: b.suggestedCategoryId,
        categoryName: categoryName(b.suggestedCategoryId),
      });
      continue;
    }
    // Transfer-only rule matched (no category). Guards mirror web
    // inbox-to-approve-tab.tsx: outflow rows only (`amount < 0` — the source
    // debit leg links to the bank row), dest must exist, be non-investment,
    // and not be the source account (the /approve endpoint refuses those).
    if (
      opts?.includeTransfers &&
      opts.accounts &&
      b.suggestedTransferAccountId != null &&
      b.amount < 0
    ) {
      const dest = opts.accounts.find((a) => a.id === b.suggestedTransferAccountId);
      if (dest && dest.isInvestment !== true && dest.id !== b.accountId) {
        map.set(b.id, {
          kind: "transfer",
          destAccountId: dest.id,
          destAccountName: safeAccountName(dest),
        });
      }
    }
  }
  return map;
}

/**
 * Build the per-bank-row "possible ledger duplicate" map. A bank row maps to
 * the existing UNLINKED ledger tx the server match engine flagged it as
 * duplicating (`bankTransactions[id].duplicateOfTransactionId`). Mirrors web
 * InboxToApproveTab.duplicateByBank — the card surfaces a "Link to existing
 * vs Keep separate" choice instead of a one-tap approve that would mint a
 * second ledger entry (web parity, 2026-06-04). Drops rows whose referenced
 * tx snapshot is missing (defensive).
 */
export function buildDuplicateByBank(
  snap: ReconcileSuggestions | null,
): Map<string, CardDuplicate> {
  const map = new Map<string, CardDuplicate>();
  if (!snap) return map;
  for (const b of Object.values(snap.bankTransactions)) {
    if (b.duplicateOfTransactionId == null) continue;
    const tx = snap.transactions[b.duplicateOfTransactionId];
    if (!tx) continue;
    map.set(b.id, {
      transactionId: tx.id,
      txPayee: tx.payee,
      txDate: tx.date,
      txAmount: tx.amount,
      txCurrency: tx.currency,
    });
  }
  return map;
}

/**
 * Resolve the categoryId to commit when the user taps the one-tap primary
 * action. Returns null when the choice needs the category picker — a 'match'
 * suggestion whose category can't be mapped to a known categoryId, or a
 * 'transfer' suggestion (which the screen handles via commitTransfer first).
 */
export function resolveSuggestedCategoryId(
  suggestion: CardSuggestion | null | undefined,
  categoryIdByName: (name: string) => number | null,
): number | null {
  if (!suggestion) return null;
  if (suggestion.kind === "create") return suggestion.categoryId;
  // 'transfer' kinds carry no category — the screen branches on them first.
  if (suggestion.kind === "transfer") return null;
  if (suggestion.txCategoryName) {
    return categoryIdByName(suggestion.txCategoryName);
  }
  return null;
}

// ─── Mode metadata (RN-friendly; web's MODES uses tailwind classes) ──────────

export interface ModeMeta {
  label: string;
  subLabel: string;
  /** Icon name in the mobile Icon set. */
  icon: IconName;
  gates: number;
  /** Semantic theme color token used for the chip/banner tint. */
  tone: "pos" | "primary" | "mutedForeground";
}

export const MODE_META: Record<AccountMode, ModeMeta> = {
  auto: {
    label: "Auto-pilot",
    subLabel: "File → ledger. Rules auto-categorize.",
    icon: "zap",
    gates: 0,
    tone: "pos",
  },
  approve: {
    label: "Approve-each",
    subLabel: "File → bank. You approve each ledger entry.",
    icon: "shield",
    gates: 1,
    tone: "primary",
  },
  manual: {
    label: "Manual review",
    subLabel: "Two-pane staging + reconcile — on the web app.",
    icon: "eye",
    gates: 2,
    tone: "mutedForeground",
  },
};

export const MODE_ORDER: AccountMode[] = ["auto", "approve", "manual"];

export function isMode(v: unknown): v is AccountMode {
  return v === "auto" || v === "approve" || v === "manual";
}
