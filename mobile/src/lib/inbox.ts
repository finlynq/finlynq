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

/** Per-bank-row suggestion the RowCard renders. Either a match against an
 *  existing tx, or a rule-engine "create as <category>" proposal. */
export type CardSuggestion =
  | {
      kind: "match";
      transactionId: number;
      txPayee: string | null;
      txCategoryName: string | null;
    }
  | { kind: "create"; categoryId: number; categoryName: string };

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
 * `suggestedCategoryId`. Mirrors web InboxToApproveTab.suggestionByBank.
 */
export function buildSuggestionByBank(
  snap: ReconcileSuggestions | null,
  categoryName: (id: number) => string,
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
  // 2) Fallback: the match-engine's suggestedCategoryId on the bank row.
  for (const b of Object.values(snap.bankTransactions)) {
    if (map.has(b.id)) continue;
    if (b.suggestedCategoryId != null) {
      map.set(b.id, {
        kind: "create",
        categoryId: b.suggestedCategoryId,
        categoryName: categoryName(b.suggestedCategoryId),
      });
    }
  }
  return map;
}

/**
 * Resolve the categoryId to commit when the user taps the one-tap primary
 * action. Returns null when the choice needs the category picker — a 'match'
 * suggestion whose category can't be mapped to a known categoryId.
 */
export function resolveSuggestedCategoryId(
  suggestion: CardSuggestion | null | undefined,
  categoryIdByName: (name: string) => number | null,
): number | null {
  if (!suggestion) return null;
  if (suggestion.kind === "create") return suggestion.categoryId;
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
