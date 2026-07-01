// SimpleFIN → RawTransaction transform (pure, dependency-free).
//
// SimpleFIN Protocol: https://www.simplefin.org/protocol.html
// The `/accounts` endpoint returns one object per linked account, each with a
// nested `transactions[]` array. This transform flattens those into Finlynq
// RawTransaction rows, grouped by account so the orchestrator can resolve /
// create the matching Finlynq account before writing to the bank ledger.
//
// Sign convention matches Finlynq: SimpleFIN outflows are NEGATIVE amounts.
// Payee is kept PLAINTEXT — `import_hash` (generateImportHash) is computed over
// the plaintext payee downstream; encryption happens at the ledger write.

import { type RawTransaction, isReasonableAmount } from "../types";

/** A single posting inside a SimpleFIN account. Amounts are decimal STRINGS. */
export interface SimpleFinTransaction {
  id: string;
  /** Epoch seconds — when the transaction posted. */
  posted: number;
  /** Signed decimal string, e.g. "-33.90". Outflow negative. */
  amount: string | number;
  description?: string;
  payee?: string;
  memo?: string;
  /** True while the transaction is still pending (not yet posted). */
  pending?: boolean;
  /** Epoch seconds — when the purchase happened (may precede `posted`). */
  transacted_at?: number;
  /** Merchant Category Code (ISO 18245), e.g. "5812" (restaurants). */
  mcc?: string;
}

export interface SimpleFinOrg {
  name?: string;
  domain?: string;
}

export interface SimpleFinAccount {
  org?: SimpleFinOrg;
  id: string;
  name: string;
  /** ISO 4217 code for banks (e.g. "USD"); may be a URL for non-fiat. */
  currency: string;
  /** Signed decimal string. */
  balance?: string;
  "available-balance"?: string;
  /** Epoch seconds. */
  "balance-date"?: number;
  transactions?: SimpleFinTransaction[];
}

export interface SimpleFinAccountsResponse {
  errors?: string[];
  accounts: SimpleFinAccount[];
}

/** One SimpleFIN account plus its transformed Finlynq rows. */
export interface SimplefinAccountRows {
  /** SimpleFIN account id — stable identity key for the persisted mapping. */
  externalId: string;
  /** SimpleFIN account display name (becomes the Finlynq account name on create). */
  name: string;
  /** ISO currency (normalized; falls back to `defaultCurrency`). */
  currency: string;
  /** Latest reported balance, or null when absent/unparseable. */
  balance: number | null;
  /** YYYY-MM-DD of the balance, or null. */
  balanceDate: string | null;
  rows: RawTransaction[];
}

export interface SimplefinTransformResult {
  accounts: SimplefinAccountRows[];
  /** Count of `pending: true` rows skipped across all accounts. */
  skippedPending: number;
  /** Provider-reported errors + per-row rejections (bad amount / date). */
  errors: string[];
}

export interface SimplefinTransformOptions {
  /** Currency to use when a SimpleFIN account's currency isn't a plain ISO code. */
  defaultCurrency?: string;
  /** Include `pending: true` rows. Default false (skip them). */
  includePending?: boolean;
}

/** Epoch seconds → "YYYY-MM-DD" (UTC). Empty string on a non-finite input. */
export function epochToISODate(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return "";
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** A SimpleFIN `currency` is either an ISO 4217 code or a URL (non-fiat). */
function normalizeCurrency(raw: string | undefined, fallback: string): string {
  if (raw && /^[A-Za-z]{3}$/.test(raw)) return raw.toUpperCase();
  return fallback;
}

function parseAmount(raw: string | number): number {
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

/**
 * Flatten a SimpleFIN `/accounts` response into per-account RawTransaction[].
 * Pending rows are skipped by default; malformed rows (bad amount/date) are
 * dropped and reported in `errors` rather than throwing.
 */
export function simplefinToRawTransactions(
  resp: SimpleFinAccountsResponse,
  opts: SimplefinTransformOptions = {},
): SimplefinTransformResult {
  const defaultCurrency = opts.defaultCurrency ?? "USD";
  const includePending = opts.includePending ?? false;
  const errors: string[] = [...(resp.errors ?? [])];
  let skippedPending = 0;

  const accounts: SimplefinAccountRows[] = [];

  for (const acct of resp.accounts ?? []) {
    const currency = normalizeCurrency(acct.currency, defaultCurrency);
    const name = (acct.name || acct.org?.name || acct.id || "Account").trim();
    const rows: RawTransaction[] = [];

    for (const tx of acct.transactions ?? []) {
      if (tx.pending && !includePending) {
        skippedPending += 1;
        continue;
      }
      const amount = parseAmount(tx.amount);
      if (!isReasonableAmount(amount)) {
        errors.push(
          `Account "${name}" tx ${tx.id}: amount out of range (${String(tx.amount)})`,
        );
        continue;
      }
      const date = epochToISODate(tx.posted || tx.transacted_at || 0);
      if (!date) {
        errors.push(`Account "${name}" tx ${tx.id}: missing/invalid posted date`);
        continue;
      }
      const payee = (tx.payee || tx.description || "").trim();
      const memo = (tx.memo || "").trim();
      const note = memo && memo !== payee ? memo : undefined;
      // Merchant category code → a `mcc:<code>` tag so auto-categorization rules
      // can match on it (e.g. "tags contains mcc:5812" → Dining).
      const mcc = (tx.mcc || "").trim();
      const tags = mcc ? `mcc:${mcc}` : undefined;

      rows.push({
        date,
        account: name,
        amount,
        payee,
        currency,
        note,
        tags,
        fitId: tx.id,
      });
    }

    const balance =
      acct.balance != null && Number.isFinite(parseFloat(acct.balance))
        ? Math.round(parseFloat(acct.balance) * 100) / 100
        : null;
    const balanceDate = acct["balance-date"]
      ? epochToISODate(acct["balance-date"]) || null
      : null;

    accounts.push({
      externalId: acct.id,
      name,
      currency,
      balance,
      balanceDate,
      rows,
    });
  }

  return { accounts, skippedPending, errors };
}
