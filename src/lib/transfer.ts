/**
 * Transfer pair primitive — atomic create / load / update / delete of a
 * pair of transactions that represent a single user transfer between two
 * accounts.
 *
 * A transfer pair = two `transactions` rows that:
 *   1. share a UUID `link_id` (server-generated; never accept from client),
 *   2. both reference a `type='R'` (Reconciliation) category — the canonical
 *      "Transfer" category, auto-created on first use,
 *   3. point at two DIFFERENT user-owned accounts (debit + credit),
 *   4. carry opposite-signed `amount` (negative on source, positive on dest).
 *
 * Cross-currency support: each leg's `amount` is in its own account currency.
 * Both legs share `enteredCurrency = sourceAccount.currency` (the trade
 * currency the user knows they sent). The destination leg's `enteredFxRate`
 * captures the actual conversion that landed (= receivedAmount / sentAmount),
 * so editing it later preserves the booked rate exactly.
 *
 * Atomicity: every mutating helper wraps both row writes in a single
 * `db.transaction()` block — partial commits would leave the user with a
 * "phantom debit/credit" that breaks balances.
 *
 * Used by:
 *   - REST POST/PUT/DELETE /api/transactions/transfer
 *   - MCP HTTP & stdio: record_transfer / update_transfer / delete_transfer
 *
 * Encryption invariants follow the same rules as record_transaction:
 *   - payee/note/tags go through `encryptTxWrite` before INSERT/UPDATE
 *   - link_id stays plaintext (excluded from TX_ENCRYPTED_FIELDS)
 *   - The auto-created Transfer category writes name_ct + name_lookup
 *     dual-write per Stream D when a DEK is available.
 */

import { randomUUID } from "crypto";
import type { Pool } from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { encryptTxWrite, decryptTxRows, buildNameFields, nameLookup } from "@/lib/crypto/encrypted-columns";
import { encryptField, decryptField } from "@/lib/crypto/envelope";
import { resolveTxAmountsCore } from "@/lib/currency-conversion";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { buildHoldingResolver } from "@/lib/external-import/portfolio-holding-resolver";
import {
  InvestmentHoldingRequiredError,
  isInvestmentAccount,
} from "@/lib/investment-account";
import type { FormatTag, TransactionSource } from "@/lib/tx-source";
import { isFormatTag } from "@/lib/tx-source";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TransferPairOk = {
  ok: true;
  linkId: string;
  fromTransactionId: number;
  toTransactionId: number;
  fromAmount: number;          // signed account-currency amount on the source row (negative)
  fromCurrency: string;        // source account currency
  toAmount: number;            // signed account-currency amount on the destination row (positive)
  toCurrency: string;          // destination account currency
  enteredFxRate: number;       // 1 for same-currency; receivedAmount/enteredAmount otherwise
  isCrossCurrency: boolean;
  /** Set when the transfer carried shares (in-kind move). */
  holding?: {
    /** Source-side holding name (what the user typed on the From leg). */
    name: string;
    /** Destination-side holding name. Same as `name` unless caller passed
     *  a distinct destHoldingName. */
    destName: string;
    /** Absolute share count LEAVING source. */
    quantity: number;
    /** Absolute share count ARRIVING at destination — same as `quantity`
     *  unless caller passed `destQuantity` to record a split / merger /
     *  share-class conversion. */
    destQuantity: number;
    fromHoldingId: number;     // source-account holding id
    toHoldingId: number;       // destination-account holding id (auto-created if missing)
  };
};

export type TransferPairFail = {
  ok: false;
  /** Stable machine code so REST + MCP surfaces can branch identically. */
  code:
    | "same-account"
    | "account-not-found"
    | "fx-currency-needs-override"
    | "invalid-amount"
    | "transfer-not-found"
    | "not-a-transfer-pair"
    | "holding-not-found"
    | "no-cash-holding"
    | "invalid-holding-spec";
  /** Human-readable message. Safe to surface to end users. */
  message: string;
  /** Which side caused an FX-fallback (so the UI can highlight it). */
  side?: "source" | "destination";
  /** Echo of the offending currency for FX errors. */
  currency?: string;
};

export type TransferPairResult = TransferPairOk | TransferPairFail;

export type CreateTransferOpts = {
  userId: string;
  dek: Buffer;
  fromAccountId: number;
  toAccountId: number;
  /**
   * Positive amount the user sent, in the source account's currency.
   * Can be 0 when this is a pure in-kind transfer (holdingName + quantity
   * provided). For cash-only transfers must be > 0.
   */
  enteredAmount: number;
  /** YYYY-MM-DD; defaults to today. */
  date?: string;
  /**
   * Cross-currency override: the actual amount that landed in the destination
   * account, in the DESTINATION's currency. When set, `enteredFxRate` is
   * locked to `receivedAmount / enteredAmount` instead of running through
   * the FX service. Ignored when the two accounts share a currency.
   */
  receivedAmount?: number;
  /**
   * In-kind transfer fields. When `holdingName` + `quantity` are BOTH set,
   * the source leg gets portfolio_holding_id resolved against
   * (sourceAccount, holdingName) and MUST already exist (you can't send
   * shares you don't have); the destination leg resolves against
   * (destAccount, destHoldingName ?? holdingName), auto-creating if missing.
   *
   * `quantity` is the positive count of shares LEAVING source. `destQuantity`
   * is the count ARRIVING at destination — defaults to `quantity` for the
   * normal case (pure ACATS), but lets the caller record asymmetric in-kind
   * events:
   *   - Stock split: source 10 → dest 30 (3-for-1)
   *   - Reverse split: source 30 → dest 10 (1-for-3)
   *   - Merger / share-class conversion: source 100 of X → dest 60 of Y
   *
   * `destHoldingName` lets the caller bind to a different label on the
   * destination side — e.g. source = "Gold Ounce" but the destination
   * already has "Au Bullion" or you want a renamed entry. Defaults to
   * `holdingName`.
   *
   * Use cases:
   *   - Pure in-kind ACATS: enteredAmount=0, holdingName + quantity set
   *   - In-kind with cost basis snapshot: enteredAmount > 0 (book value), holdingName + quantity set
   *   - Cash-only: holdingName + quantity both omitted
   *
   * Either both holdingName+quantity or neither — passing one without the
   * other returns `invalid-holding-spec`. `destHoldingName` and
   * `destQuantity` are only honored when the in-kind side is set.
   */
  holdingName?: string;
  destHoldingName?: string;
  quantity?: number;
  destQuantity?: number;
  /**
   * Explicit FK ids for cash legs into investment accounts (issue #22).
   * Distinct from the in-kind `holdingName` path: these pin a leg's
   * `portfolio_holding_id` directly without touching `quantity`, so the
   * portfolio aggregator's cash-sleeve branch (currency-as-symbol) keeps
   * tracking dollars via `transactions.amount`. Use this when sending cash
   * to or from an investment account without recording a share move — the
   * UI binds it to the per-account Cash holding via the "Cash (auto)"
   * picker option. Ignored on a leg that already resolved an in-kind
   * holding via `holdingName`. Validates: the supplied id must reference a
   * holding row owned by `userId` and scoped to that leg's account; an
   * `account-not-found` style failure otherwise.
   */
  fromHoldingId?: number;
  toHoldingId?: number;
  note?: string;
  tags?: string;
  /**
   * When set, the file/wire format the rows arrived as (e.g. `"csv"`,
   * `"ofx"`, `"ibkr-xml"`) is prepended to both legs' `tags` as
   * `source:<format>`. Lets future statement reconciliations dedup against
   * rows the bank side has already imported. No-op when undefined; merged
   * with caller-supplied tags rather than replacing them.
   *
   * NOTE (issue #62): this is now a **format** name, NOT a connector or
   * institution name. Use `"csv"` for connector-orchestrated CSV imports
   * (WealthPosition, IBKR activity-CSV), `"ibkr-xml"` for IBKR Flex XML,
   * etc. Institution name lives on the account; per-row tags describe
   * shape only. Runtime-asserted via `isFormatTag()` in `applySourceTag` —
   * unknown values throw rather than silently writing bogus tags.
   *
   * Distinct from the audit-column `txSource` below (issue #28). The two
   * coexist because the tag captures file-shape provenance while the audit
   * column captures the writer surface. Setting `source` here does NOT
   * auto-derive `txSource`; the route handler sets both.
   */
  source?: FormatTag;
  /**
   * Audit-source attribution (issue #28). Hard-coded by each route handler
   * at the boundary: 'manual' for UI POST, 'mcp_http' / 'mcp_stdio' for
   * MCP transports, 'connector' for the WP / future-broker orchestrators.
   * Both legs of the pair receive the same value — the surface that
   * initiated the transfer is what matters, not the abstract concept of
   * "transfer". Defaults to 'manual' when omitted.
   */
  txSource?: TransactionSource;
};

export type UpdateTransferOpts = {
  userId: string;
  dek: Buffer;
  /** Either linkId OR transactionId is required to identify the pair. */
  linkId?: string;
  transactionId?: number;
  fromAccountId?: number;
  toAccountId?: number;
  enteredAmount?: number;
  date?: string;
  receivedAmount?: number;
  /**
   * Update the in-kind side of the transfer. Pass both name + quantity to
   * (re)bind a holding; pass `null` for both to clear the in-kind side and
   * make this a pure cash transfer. Omit both to leave it untouched.
   *
   * `destQuantity` updates the destination-side share count independently —
   * useful for recording stock splits / mergers / share-class conversions
   * after the fact. Defaults to `quantity`.
   *
   * `destHoldingName` mirrors create-side behavior — set it alongside
   * `holdingName` to bind the destination leg to a different label;
   * defaults to `holdingName`. Ignored when `holdingName` is null/undefined.
   */
  holdingName?: string | null;
  destHoldingName?: string | null;
  quantity?: number | null;
  destQuantity?: number | null;
  note?: string;
  tags?: string;
};

export type DeleteTransferOpts = {
  userId: string;
  /** Either linkId OR transactionId is required to identify the pair. */
  linkId?: string;
  transactionId?: number;
};

export type TransferPair = {
  linkId: string;
  source: TransferLeg;
  destination: TransferLeg;
};

export type TransferLeg = {
  id: number;
  date: string;
  accountId: number;
  accountName: string | null;
  accountCurrency: string;
  categoryId: number;
  categoryName: string | null;
  amount: number;
  currency: string;
  enteredAmount: number | null;
  enteredCurrency: string | null;
  enteredFxRate: number | null;
  payee: string | null;
  note: string | null;
  tags: string | null;
  linkId: string;
  /** Set when the leg references a portfolio holding (in-kind transfer). */
  portfolioHoldingId: number | null;
  portfolioHoldingName: string | null;
  /** Signed share count: negative on source leg, positive on destination. */
  quantity: number | null;
};

// ─── Internal helpers ───────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Resolve (or auto-create) the user's Transfer category.
 * Mirrors the WP ZIP orchestrator's pattern at
 * src/lib/external-import/zip-orchestrator.ts:275-298.
 *
 * Strategy:
 *   1. Find any existing category with type='R' for this user (preferred:
 *      one literally named "Transfer", else the first 'R' row).
 *   2. If none, INSERT one with `{type:'R', group:'Transfer', name:'Transfer'}`,
 *      writing name_ct + name_lookup per Stream D.
 *
 * Auto-create is name-idempotent enough for the common case; if a user has
 * deleted their Transfer category we'll recreate it. Multiple 'R' categories
 * on the same user (Reconciliation, Transfer, ...) won't collide because
 * we ORDER BY id LIMIT 1 — the user's earliest-created reconciliation
 * category wins. Power users who want a specific transfer category can
 * always edit the row directly via the categories UI.
 */
async function resolveTransferCategoryId(
  // Drizzle's PG transaction context is just a thin wrapper over the same
  // builder API; typing it as `any` keeps callers from needing to thread
  // generics. Internally we only use insert/select with the schema we
  // import, so this is safe.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  userId: string,
  dek: Buffer | null,
): Promise<number> {
  const existing = await tx
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .where(and(eq(schema.categories.userId, userId), eq(schema.categories.type, "R")))
    .orderBy(schema.categories.id);
  // Prefer a row literally named "Transfer" (case-insensitive); fall back to
  // the first 'R' row.
  const preferred = existing.find(
    (r: { name: string | null }) => (r.name ?? "").trim().toLowerCase() === "transfer",
  );
  if (preferred) return preferred.id as number;
  if (existing.length > 0) return existing[0].id as number;

  // Auto-create.
  const enc = buildNameFields(dek, { name: "Transfer" });
  const [created] = await tx
    .insert(schema.categories)
    .values({
      userId,
      type: "R",
      group: "Transfer",
      name: "Transfer",
      ...enc,
    })
    .returning({ id: schema.categories.id });
  return created.id as number;
}

function defaultPayee(direction: "out" | "in", otherAccountName: string | null): string {
  const other = otherAccountName ?? "another account";
  return direction === "out" ? `Transfer to ${other}` : `Transfer from ${other}`;
}

/**
 * Merge a `source:<format>` tag into a user-supplied tags string (issue #62).
 * Idempotent: if the tag is already present (case-insensitive), the input is
 * returned unchanged so re-running an import doesn't accumulate duplicates.
 * Empty `source` is a no-op. Tags are stored comma-separated, matching what
 * `transactions.tags` already holds.
 *
 * `source` is a **format** name (csv | excel | pdf | ofx | qfx | ibkr-xml |
 * email) — NOT a connector or institution. The TypeScript signature on
 * `CreateTransferOpts.source` is `FormatTag`, but the runtime guard below
 * defends against JS callers passing the old `"wealthposition"` /
 * `"ibkr"` strings — those throw rather than silently writing a bogus tag.
 */
function applySourceTag(tags: string, source: string | undefined): string {
  if (!source || !source.trim()) return tags;
  const trimmed = source.trim();
  if (!isFormatTag(trimmed)) {
    throw new Error(
      `applySourceTag: invalid format tag "${trimmed}". ` +
        `Expected one of csv|excel|pdf|ofx|qfx|ibkr-xml|email (issue #62).`,
    );
  }
  const tag = `source:${trimmed}`;
  const existing = tags
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (existing.some((t) => t.toLowerCase() === tag.toLowerCase())) return tags;
  return [tag, ...existing].join(",");
}

// ─── Create ─────────────────────────────────────────────────────────────────

export async function createTransferPair(
  opts: CreateTransferOpts,
): Promise<TransferPairResult> {
  const { userId, dek } = opts;
  const date = opts.date ?? todayISO();

  // In-kind validation up front. Both fields move together.
  const wantsHolding =
    (opts.holdingName != null && opts.holdingName.trim() !== "") ||
    (opts.quantity != null && opts.quantity !== 0);
  if (wantsHolding) {
    if (!opts.holdingName || opts.holdingName.trim() === "") {
      return { ok: false, code: "invalid-holding-spec", message: "holdingName is required when quantity is set" };
    }
    if (opts.quantity == null || !Number.isFinite(opts.quantity) || opts.quantity <= 0) {
      return { ok: false, code: "invalid-amount", message: "quantity must be a positive number when holdingName is set" };
    }
    if (
      opts.destQuantity !== undefined &&
      (!Number.isFinite(opts.destQuantity) || opts.destQuantity <= 0)
    ) {
      return { ok: false, code: "invalid-amount", message: "destQuantity must be a positive number when provided" };
    }
  }

  // Validate up-front. Early rejection avoids opening a DB transaction.
  // Cash amount: must be positive UNLESS this is a pure in-kind transfer
  // (holding+quantity supplied), in which case 0 is allowed.
  if (!Number.isFinite(opts.enteredAmount) || opts.enteredAmount < 0) {
    return {
      ok: false,
      code: "invalid-amount",
      message: "enteredAmount must be a non-negative number",
    };
  }
  if (!wantsHolding && opts.enteredAmount === 0) {
    return {
      ok: false,
      code: "invalid-amount",
      message: "enteredAmount must be > 0 (or supply holdingName + quantity for an in-kind transfer)",
    };
  }
  if (
    opts.receivedAmount !== undefined &&
    (!Number.isFinite(opts.receivedAmount) || opts.receivedAmount < 0)
  ) {
    return {
      ok: false,
      code: "invalid-amount",
      message: "receivedAmount must be a non-negative number when provided",
    };
  }
  // Same-account is normally rejected — moving cash from an account to
  // itself is a no-op. The exception: in-kind transfers between TWO
  // DIFFERENT holdings in the same brokerage (rebalances, position swaps).
  // We let same-account through here when wantsHolding is true; the holding-
  // resolution block below catches the "same account AND same holding"
  // degenerate case (a true no-op) with a separate invalid-holding-spec error.
  if (opts.fromAccountId === opts.toAccountId && !wantsHolding) {
    return {
      ok: false,
      code: "same-account",
      message: "From and to accounts must differ for a cash transfer",
    };
  }

  // Pre-resolve both account currencies (ownership checks are cheap, and we
  // need the source currency to short-circuit FX before opening a tx).
  const accounts = await db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      currency: schema.accounts.currency,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, userId),
        inArray(schema.accounts.id, [opts.fromAccountId, opts.toAccountId]),
      ),
    );
  const fromAcct = accounts.find((a) => a.id === opts.fromAccountId);
  const toAcct = accounts.find((a) => a.id === opts.toAccountId);
  if (!fromAcct) {
    return { ok: false, code: "account-not-found", message: `Source account #${opts.fromAccountId} not found`, side: "source" };
  }
  if (!toAcct) {
    return { ok: false, code: "account-not-found", message: `Destination account #${opts.toAccountId} not found`, side: "destination" };
  }

  const fromCurrency = (fromAcct.currency ?? "CAD").toUpperCase();
  const toCurrency = (toAcct.currency ?? "CAD").toUpperCase();
  const isCrossCurrency = fromCurrency !== toCurrency;

  // Source leg always uses the source account's currency — no FX needed.
  const sentAmount = round2(opts.enteredAmount);

  // Destination leg: derive via FX unless the caller supplied receivedAmount.
  // Pure in-kind transfers (sentAmount=0) skip the FX step entirely — there's
  // no cash to convert and rate=1 is meaningless on a zero amount.
  let receivedAmount: number;
  let enteredFxRate: number;
  if (sentAmount === 0) {
    receivedAmount = 0;
    enteredFxRate = 1;
  } else if (!isCrossCurrency) {
    receivedAmount = sentAmount;
    enteredFxRate = 1;
  } else if (opts.receivedAmount !== undefined) {
    receivedAmount = round2(opts.receivedAmount);
    enteredFxRate = sentAmount === 0 ? 1 : receivedAmount / sentAmount;
  } else {
    const conv = await resolveTxAmountsCore({
      accountCurrency: toCurrency,
      date,
      userId,
      enteredAmount: sentAmount,
      enteredCurrency: fromCurrency,
    });
    if (!conv.ok) {
      return {
        ok: false,
        code: conv.code === "fx-currency-needs-override" ? "fx-currency-needs-override" : "invalid-amount",
        message: conv.message,
        side: "destination",
        currency: conv.currency,
      };
    }
    receivedAmount = conv.amount;
    enteredFxRate = conv.enteredFxRate;
  }

  // Resolve in-kind holding ids (source MUST exist, destination auto-creates).
  let holdingResolved:
    | {
        fromHoldingId: number;
        toHoldingId: number;
        quantity: number;
        destQuantity: number;
        name: string;
        destName: string;
      }
    | null = null;
  if (wantsHolding) {
    const trimmedName = opts.holdingName!.trim();
    const trimmedDestName =
      opts.destHoldingName != null && opts.destHoldingName.trim() !== ""
        ? opts.destHoldingName.trim()
        : trimmedName;
    const fromHoldingId = await findHoldingIdByAccountAndName(userId, dek, fromAcct.id, trimmedName);
    if (fromHoldingId == null) {
      return {
        ok: false,
        code: "holding-not-found",
        message: `Holding "${trimmedName}" not found in source account "${fromAcct.name}". Create it on the destination side first if you intend to record an opening position.`,
        side: "source",
      };
    }
    // Issue #92: strict find-only on the destination side. We previously
    // auto-created a holding row here via buildHoldingResolver, which:
    //   1. silently auto-created a Cash sleeve when the user typo'd or
    //      forgot to call add_portfolio_holding first, and
    //   2. crashed with a raw 23505 duplicate-key DB error when the partial
    //      unique index already had a matching row.
    // Both legs MUST already exist. The user is told exactly which
    // add_portfolio_holding call to make if they want the row created.
    const toHoldingId = await findHoldingIdByAccountAndName(userId, dek, toAcct.id, trimmedDestName);
    if (toHoldingId == null) {
      return {
        ok: false,
        code: "no-cash-holding",
        message: `No holding named "${trimmedDestName}" found in destination account "${toAcct.name}". Create it first: add_portfolio_holding(account="${toAcct.name}", name="${trimmedDestName}", currency="${toCurrency}")`,
        side: "destination",
      };
    }
    // Same-account no-op guard: if source AND destination resolve to the
    // SAME holding row, the two legs would just cancel out. Reject so the
    // user doesn't accidentally write a meaningless pair (typical cause:
    // they picked the same account on both sides without changing the
    // destination holding override).
    if (fromHoldingId === toHoldingId) {
      return {
        ok: false,
        code: "invalid-holding-spec",
        message:
          fromAcct.id === toAcct.id
            ? `Source and destination both point at "${trimmedName}" in "${fromAcct.name}" — pick a different destination holding to move shares between positions in the same account.`
            : `Source and destination resolve to the same holding row — pick a different destination holding name.`,
      };
    }
    const destQty = opts.destQuantity != null ? opts.destQuantity : opts.quantity!;
    holdingResolved = {
      fromHoldingId,
      toHoldingId,
      quantity: opts.quantity!,
      destQuantity: destQty,
      name: trimmedName,
      destName: trimmedDestName,
    };
  }

  const linkId = randomUUID();
  const sourcePayee = defaultPayee("out", toAcct.name);
  const destPayee = defaultPayee("in", fromAcct.name);
  const note = opts.note ?? "";
  const tags = applySourceTag(opts.tags ?? "", opts.source);

  // Investment-account constraint (strict — issue #22): when a leg lands on
  // an is_investment account and no in-kind holding was resolved (pure-cash
  // transfer), refuse the write rather than silently defaulting to Cash.
  // Callers that *want* Cash must say so explicitly — either via the
  // in-kind `holdingName` path (with quantity) or via the explicit
  // `fromHoldingId` / `toHoldingId` FK pins (cash legs, no quantity).
  // The dialog defaults to "Cash (auto)" → the per-account Cash holding's
  // id, so the user keeps the one-click path. Non-investment legs stay
  // null. InvestmentHoldingRequiredError escapes; route handlers map to 400.
  if (opts.fromHoldingId != null && !(await holdingBelongsToAccount(userId, opts.fromHoldingId, fromAcct.id))) {
    return {
      ok: false,
      code: "holding-not-found",
      message: `Source holding #${opts.fromHoldingId} not found in account "${fromAcct.name}".`,
      side: "source",
    };
  }
  if (opts.toHoldingId != null && !(await holdingBelongsToAccount(userId, opts.toHoldingId, toAcct.id))) {
    return {
      ok: false,
      code: "holding-not-found",
      message: `Destination holding #${opts.toHoldingId} not found in account "${toAcct.name}".`,
      side: "destination",
    };
  }
  const fromHoldingId = holdingResolved?.fromHoldingId ?? opts.fromHoldingId ?? null;
  const toHoldingId = holdingResolved?.toHoldingId ?? opts.toHoldingId ?? null;
  if (fromHoldingId == null && (await isInvestmentAccount(userId, fromAcct.id))) {
    throw new InvestmentHoldingRequiredError(fromAcct.id);
  }
  if (toHoldingId == null && (await isInvestmentAccount(userId, toAcct.id))) {
    throw new InvestmentHoldingRequiredError(toAcct.id);
  }

  // Atomic dual-insert. If either INSERT throws we want both rows to roll
  // back — never leave a half-recorded transfer.
  let fromTransactionId = 0;
  let toTransactionId = 0;
  try {
    await db.transaction(async (tx) => {
      const categoryId = await resolveTransferCategoryId(tx, userId, dek);

      const sourceRow = encryptTxWrite(dek, {
        payee: sourcePayee,
        note,
        tags,
      });
      const destRow = encryptTxWrite(dek, {
        payee: destPayee,
        note,
        tags,
      });

      // Issue #28: both legs share the writer-surface attribution.
      const txSource: TransactionSource = opts.txSource ?? "manual";

      const [sourceInserted] = await tx
        .insert(schema.transactions)
        .values({
          userId,
          date,
          accountId: fromAcct.id,
          categoryId,
          currency: fromCurrency,
          amount: -sentAmount,
          enteredCurrency: fromCurrency,
          enteredAmount: -sentAmount,
          enteredFxRate: 1,
          portfolioHoldingId: fromHoldingId,
          // quantity stays null on pure-cash legs; only in-kind transfers
          // carry share counts. Cash sleeves track cash amount, not shares.
          quantity: holdingResolved ? -Math.abs(holdingResolved.quantity) : null,
          source: txSource,
          ...sourceRow,
          linkId,
        })
        .returning({ id: schema.transactions.id });

      const [destInserted] = await tx
        .insert(schema.transactions)
        .values({
          userId,
          date,
          accountId: toAcct.id,
          categoryId,
          currency: toCurrency,
          amount: receivedAmount,
          enteredCurrency: fromCurrency,
          enteredAmount: sentAmount,
          enteredFxRate,
          portfolioHoldingId: toHoldingId,
          // destQuantity may differ from source quantity (stock split,
          // merger, share-class conversion). Null on pure-cash legs.
          quantity: holdingResolved ? Math.abs(holdingResolved.destQuantity) : null,
          source: txSource,
          ...destRow,
          linkId,
        })
        .returning({ id: schema.transactions.id });

      fromTransactionId = sourceInserted.id as number;
      toTransactionId = destInserted.id as number;
    });
  } catch (err) {
    return {
      ok: false,
      code: "invalid-amount",
      message: err instanceof Error ? err.message : "Transfer write failed",
    };
  }

  invalidateUserTxCache(userId);

  return {
    ok: true,
    linkId,
    fromTransactionId,
    toTransactionId,
    fromAmount: -sentAmount,
    fromCurrency,
    toAmount: receivedAmount,
    toCurrency,
    enteredFxRate,
    isCrossCurrency,
    ...(holdingResolved
      ? {
          holding: {
            name: holdingResolved.name,
            destName: holdingResolved.destName,
            quantity: holdingResolved.quantity,
            destQuantity: holdingResolved.destQuantity,
            fromHoldingId: holdingResolved.fromHoldingId,
            toHoldingId: holdingResolved.toHoldingId,
          },
        }
      : {}),
  };
}

/**
 * Validate that a portfolio_holdings row exists for this user AND is bound
 * to `accountId`. Used to verify explicit `fromHoldingId` / `toHoldingId`
 * pins on a transfer leg before we trust them as the FK. Returns false on
 * cross-tenant ids, cross-account ids, and unknown ids alike — caller
 * surfaces `holding-not-found`.
 */
async function holdingBelongsToAccount(
  userId: string,
  holdingId: number,
  accountId: number,
): Promise<boolean> {
  const row = await db
    .select({ id: schema.portfolioHoldings.id })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.id, holdingId),
        eq(schema.portfolioHoldings.userId, userId),
        eq(schema.portfolioHoldings.accountId, accountId),
      ),
    )
    .get();
  return row != null;
}

/**
 * Strict source-side holding lookup. Returns null if the (account, name)
 * pair doesn't exist — the caller surfaces a `holding-not-found` error so
 * users can't accidentally "send" shares from an account that doesn't have
 * them. Mirrors the dual-index pattern in {@link buildHoldingResolver} but
 * without the auto-create branch.
 */
async function findHoldingIdByAccountAndName(
  userId: string,
  dek: Buffer | null,
  accountId: number,
  name: string,
): Promise<number | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Plaintext match first (handles legacy + dek-less rows).
  const plain = await db
    .select({ id: schema.portfolioHoldings.id })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.userId, userId),
        eq(schema.portfolioHoldings.accountId, accountId),
        eq(schema.portfolioHoldings.name, trimmed),
      ),
    )
    .limit(1);
  if (plain.length && plain[0].id != null) return plain[0].id;
  // Stream D Phase 3 NULL-plaintext rows: try the encrypted lookup.
  if (dek) {
    const lookup = nameLookup(dek, trimmed);
    const enc = await db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(
        and(
          eq(schema.portfolioHoldings.userId, userId),
          eq(schema.portfolioHoldings.accountId, accountId),
          eq(schema.portfolioHoldings.nameLookup, lookup),
        ),
      )
      .limit(1);
    if (enc.length && enc[0].id != null) return enc[0].id;
  }
  return null;
}

// ─── Load ───────────────────────────────────────────────────────────────────

/**
 * Load and validate a transfer pair. Returns null if the linkId/transactionId
 * resolves to a row that doesn't satisfy the (relaxed) three-check rule:
 * link_id non-null, exactly one sibling (N≤2 legs), different accounts.
 *
 * The legacy `category_type === 'R'` requirement was dropped (#8) so
 * transfer-shaped pairs whose category was renamed by the user (e.g.
 * `Non-Cash - Transfers`) still resolve here. Updates leave `category_id`
 * alone (see `updateTransferPair`), so this is non-destructive.
 *
 * Used by both PUT and DELETE handlers + the unified edit view to confirm
 * a transfer pair before mutating it.
 */
export async function loadTransferPair(
  userId: string,
  dek: Buffer | null,
  by: { linkId?: string; transactionId?: number },
): Promise<TransferPair | null> {
  let resolvedLinkId: string | null = null;

  if (by.linkId) {
    resolvedLinkId = by.linkId;
  } else if (by.transactionId != null) {
    const row = await db
      .select({ linkId: schema.transactions.linkId })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.id, by.transactionId),
          eq(schema.transactions.userId, userId),
        ),
      )
      .limit(1);
    if (!row.length || !row[0].linkId) return null;
    resolvedLinkId = row[0].linkId;
  } else {
    return null;
  }

  const rows = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      accountId: schema.transactions.accountId,
      accountName: schema.accounts.name,
      accountCurrency: schema.accounts.currency,
      categoryId: schema.transactions.categoryId,
      categoryName: schema.categories.name,
      categoryType: schema.categories.type,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
      enteredAmount: schema.transactions.enteredAmount,
      enteredCurrency: schema.transactions.enteredCurrency,
      enteredFxRate: schema.transactions.enteredFxRate,
      payee: schema.transactions.payee,
      note: schema.transactions.note,
      tags: schema.transactions.tags,
      linkId: schema.transactions.linkId,
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
      portfolioHoldingName: schema.portfolioHoldings.name,
      portfolioHoldingNameCt: schema.portfolioHoldings.nameCt,
      quantity: schema.transactions.quantity,
    })
    .from(schema.transactions)
    .leftJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .leftJoin(
      schema.portfolioHoldings,
      eq(schema.transactions.portfolioHoldingId, schema.portfolioHoldings.id),
    )
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.linkId, resolvedLinkId),
      ),
    );

  // Three-check rule (categoryType==='R' relaxed in #8).
  if (rows.length !== 2) return null;
  if (rows[0].accountId === rows[1].accountId) return null;

  // Decrypt payee/note/tags so the caller can render or pre-fill the form.
  const decrypted = decryptTxRows(
    dek,
    rows as unknown as Array<Parameters<typeof decryptTxRows>[1][number]>,
  ) as typeof rows;

  // Direction: the row with negative amount is the source; the positive one
  // is destination. If both are same-signed (data-quality edge case from old
  // imports), pick the lower id as source — caller surfaces a "this looks
  // unusual" hint in that case but we still return the pair.
  let sourceRow = decrypted.find((r) => r.amount < 0) ?? null;
  let destRow = decrypted.find((r) => r.amount >= 0) ?? null;
  if (!sourceRow || !destRow || sourceRow.id === destRow.id) {
    const sorted = [...decrypted].sort((a, b) => a.id - b.id);
    sourceRow = sorted[0];
    destRow = sorted[1];
  }

  const toLeg = (r: typeof decrypted[number]): TransferLeg => {
    // Stream D: holding name may be in `nameCt` (encrypted) or plain `name`.
    let holdingName: string | null = r.portfolioHoldingName ?? null;
    if (!holdingName && r.portfolioHoldingNameCt && dek) {
      try {
        holdingName = decryptField(dek, r.portfolioHoldingNameCt);
      } catch {
        holdingName = null;
      }
    }
    return {
      id: r.id,
      date: r.date,
      accountId: r.accountId as number,
      accountName: r.accountName ?? null,
      accountCurrency: (r.accountCurrency ?? r.currency ?? "CAD").toUpperCase(),
      categoryId: r.categoryId as number,
      categoryName: r.categoryName ?? null,
      amount: r.amount,
      currency: r.currency,
      enteredAmount: r.enteredAmount ?? null,
      enteredCurrency: r.enteredCurrency ?? null,
      enteredFxRate: r.enteredFxRate ?? null,
      payee: r.payee ?? null,
      note: r.note ?? null,
      tags: r.tags ?? null,
      linkId: r.linkId as string,
      portfolioHoldingId: r.portfolioHoldingId ?? null,
      portfolioHoldingName: holdingName,
      quantity: r.quantity ?? null,
    };
  };

  return {
    linkId: resolvedLinkId,
    source: toLeg(sourceRow!),
    destination: toLeg(destRow!),
  };
}

// ─── Update ─────────────────────────────────────────────────────────────────

/**
 * Atomically update both legs of a transfer pair. The four-check rule must
 * hold (loadTransferPair returns non-null) — otherwise returns
 * `{ ok: false, code: 'not-a-transfer-pair' }` so the caller can fall back
 * to a single-row PUT against /api/transactions.
 *
 * Update semantics:
 *   - If `fromAccountId` / `toAccountId` change, both legs' `accountId` +
 *     `currency` are rewritten and FX is re-run.
 *   - If `enteredAmount` changes (with same currencies), both legs' amount
 *     fields are rewritten with the new value.
 *   - If `enteredAmount` and currencies are unchanged AND `receivedAmount`
 *     is supplied, only the destination leg's `amount` + `enteredFxRate`
 *     are rewritten — preserves the user's manual override.
 *   - `date`, `note`, `tags` are written to both legs verbatim.
 *   - The `payee` is rebuilt from the (possibly new) account names — keeps
 *     "Transfer to X" / "Transfer from X" in sync if accounts were swapped.
 */
export async function updateTransferPair(opts: UpdateTransferOpts): Promise<TransferPairResult> {
  const { userId, dek } = opts;

  const pair = await loadTransferPair(userId, dek, { linkId: opts.linkId, transactionId: opts.transactionId });
  if (!pair) {
    return {
      ok: false,
      code: "not-a-transfer-pair",
      message: "No transfer pair found for the given linkId/transactionId, or the rows don't form a clean pair",
    };
  }

  // Resolve the (possibly new) accounts. If the caller didn't pass new ids
  // we re-use the current ones from the pair.
  const desiredFromId = opts.fromAccountId ?? pair.source.accountId;
  const desiredToId = opts.toAccountId ?? pair.destination.accountId;
  // Same-account is rejected only when the result would be a pure cash
  // transfer. Same-account in-kind (rebalance between two holdings in the
  // same brokerage) is allowed; the holding-resolution block guards the
  // "same holding too" no-op separately.
  const willBeInKind =
    (opts.holdingName != null && opts.holdingName !== "") ||
    (opts.quantity != null && opts.quantity !== 0) ||
    // Untouched in-kind side from the existing pair survives the edit.
    (opts.holdingName === undefined &&
      opts.quantity === undefined &&
      ((pair.source.portfolioHoldingId != null && (pair.source.quantity ?? 0) !== 0) ||
        (pair.destination.portfolioHoldingId != null && (pair.destination.quantity ?? 0) !== 0)));
  if (desiredFromId === desiredToId && !willBeInKind) {
    return { ok: false, code: "same-account", message: "From and to accounts must differ for a cash transfer" };
  }

  const accounts = await db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      currency: schema.accounts.currency,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.userId, userId),
        inArray(schema.accounts.id, [desiredFromId, desiredToId]),
      ),
    );
  const fromAcct = accounts.find((a) => a.id === desiredFromId);
  const toAcct = accounts.find((a) => a.id === desiredToId);
  if (!fromAcct) {
    return { ok: false, code: "account-not-found", message: `Source account #${desiredFromId} not found`, side: "source" };
  }
  if (!toAcct) {
    return { ok: false, code: "account-not-found", message: `Destination account #${desiredToId} not found`, side: "destination" };
  }

  const fromCurrency = (fromAcct.currency ?? "CAD").toUpperCase();
  const toCurrency = (toAcct.currency ?? "CAD").toUpperCase();
  const isCrossCurrency = fromCurrency !== toCurrency;

  const enteredAmount = opts.enteredAmount ?? Math.abs(pair.source.amount);
  if (!Number.isFinite(enteredAmount) || enteredAmount < 0) {
    return { ok: false, code: "invalid-amount", message: "enteredAmount must be a non-negative number" };
  }
  const sentAmount = round2(enteredAmount);
  const date = opts.date ?? pair.source.date;

  // Decide the destination amount + rate.
  let receivedAmount: number;
  let enteredFxRate: number;
  // Unchanged-currencies fast-path: keep the existing rate if the user only
  // edited the amount AND didn't supply a receivedAmount override.
  const currenciesUnchanged =
    fromCurrency === pair.source.currency.toUpperCase() &&
    toCurrency === pair.destination.currency.toUpperCase();
  if (sentAmount === 0) {
    // Pure in-kind / zero-cash row — no conversion needed.
    receivedAmount = 0;
    enteredFxRate = 1;
  } else if (!isCrossCurrency) {
    receivedAmount = sentAmount;
    enteredFxRate = 1;
  } else if (opts.receivedAmount !== undefined) {
    if (!Number.isFinite(opts.receivedAmount) || opts.receivedAmount < 0) {
      return { ok: false, code: "invalid-amount", message: "receivedAmount must be a non-negative number when provided" };
    }
    receivedAmount = round2(opts.receivedAmount);
    enteredFxRate = receivedAmount / sentAmount;
  } else if (
    currenciesUnchanged &&
    opts.enteredAmount === undefined &&
    pair.destination.enteredFxRate != null &&
    Number.isFinite(pair.destination.enteredFxRate)
  ) {
    // Pure metadata edit (date/note/tags only) → preserve the booked rate
    // and amount exactly.
    enteredFxRate = pair.destination.enteredFxRate;
    receivedAmount = round2(Math.abs(pair.destination.amount));
  } else {
    // Currencies changed (account swap) OR amount changed without override
    // → re-run FX at the (possibly new) date.
    const conv = await resolveTxAmountsCore({
      accountCurrency: toCurrency,
      date,
      userId,
      enteredAmount: sentAmount,
      enteredCurrency: fromCurrency,
    });
    if (!conv.ok) {
      return {
        ok: false,
        code: conv.code === "fx-currency-needs-override" ? "fx-currency-needs-override" : "invalid-amount",
        message: conv.message,
        side: "destination",
        currency: conv.currency,
      };
    }
    receivedAmount = conv.amount;
    enteredFxRate = conv.enteredFxRate;
  }

  const note = opts.note ?? pair.source.note ?? "";
  const tags = opts.tags ?? pair.source.tags ?? "";
  const sourcePayee = defaultPayee("out", toAcct.name);
  const destPayee = defaultPayee("in", fromAcct.name);

  // Resolve the in-kind side. Tri-state semantics:
  //   - holdingName / quantity OMITTED → keep current holding binding
  //   - holdingName === null OR quantity === null → CLEAR the binding
  //   - both set → resolve fresh ids (may move to a different account/holding)
  // destHoldingName piggy-backs on this: omitted = use holdingName as default;
  // null = explicit "same as source name"; explicit string = bind dest leg
  // to a different label.
  type ResolvedHolding = {
    fromHoldingId: number | null;
    toHoldingId: number | null;
    quantity: number | null;
    destQuantity: number | null;
    name: string | null;
    destName: string | null;
    /** true when the caller explicitly modified the holding side. */
    touched: boolean;
  };
  let resolvedHolding: ResolvedHolding;
  const explicitClear = opts.holdingName === null || opts.quantity === null;
  const explicitSet =
    opts.holdingName != null &&
    opts.holdingName !== "" &&
    opts.quantity != null &&
    opts.quantity !== 0;

  if (explicitClear) {
    resolvedHolding = {
      fromHoldingId: null,
      toHoldingId: null,
      quantity: null,
      destQuantity: null,
      name: null,
      destName: null,
      touched: true,
    };
  } else if (explicitSet) {
    const trimmed = (opts.holdingName as string).trim();
    const trimmedDest =
      opts.destHoldingName != null && opts.destHoldingName !== ""
        ? (opts.destHoldingName as string).trim()
        : trimmed;
    if (!Number.isFinite(opts.quantity as number) || (opts.quantity as number) <= 0) {
      return { ok: false, code: "invalid-amount", message: "quantity must be a positive number" };
    }
    if (
      opts.destQuantity !== undefined &&
      opts.destQuantity !== null &&
      (!Number.isFinite(opts.destQuantity) || opts.destQuantity <= 0)
    ) {
      return { ok: false, code: "invalid-amount", message: "destQuantity must be a positive number when provided" };
    }
    const fromHoldingId = await findHoldingIdByAccountAndName(userId, dek, fromAcct.id, trimmed);
    if (fromHoldingId == null) {
      return {
        ok: false,
        code: "holding-not-found",
        message: `Holding "${trimmed}" not found in source account "${fromAcct.name}".`,
        side: "source",
      };
    }
    const resolver = await buildHoldingResolver(userId, dek);
    const toHoldingId = await resolver.resolve(toAcct.id, trimmedDest);
    if (toHoldingId == null) {
      return {
        ok: false,
        code: "holding-not-found",
        message: `Could not resolve a destination holding row for "${trimmedDest}" under "${toAcct.name}".`,
        side: "destination",
      };
    }
    if (fromHoldingId === toHoldingId) {
      return {
        ok: false,
        code: "invalid-holding-spec",
        message:
          fromAcct.id === toAcct.id
            ? `Source and destination both point at "${trimmed}" in "${fromAcct.name}" — pick a different destination holding.`
            : `Source and destination resolve to the same holding row — pick a different destination holding name.`,
      };
    }
    resolvedHolding = {
      fromHoldingId,
      toHoldingId,
      quantity: opts.quantity as number,
      destQuantity:
        opts.destQuantity != null ? (opts.destQuantity as number) : (opts.quantity as number),
      name: trimmed,
      destName: trimmedDest,
      touched: true,
    };
  } else if (opts.holdingName != null || opts.quantity != null) {
    // Partial modification — must pass both or neither.
    return {
      ok: false,
      code: "invalid-holding-spec",
      message: "Pass both holdingName and quantity to (re)bind the in-kind side, or both null to clear it.",
    };
  } else {
    // Untouched: re-derive from existing pair so account moves still keep
    // the binding consistent. If the user moved both legs to different
    // accounts, the existing portfolioHoldingId references the OLD account
    // and would orphan; in that case we re-resolve under the new accounts
    // using the existing holding names (preserving any source/dest split).
    const existingSourceName = pair.source.portfolioHoldingName ?? null;
    const existingDestName = pair.destination.portfolioHoldingName ?? existingSourceName;
    const existingSourceQty =
      pair.source.quantity != null ? Math.abs(pair.source.quantity) : null;
    const existingDestQty =
      pair.destination.quantity != null ? Math.abs(pair.destination.quantity) : null;
    // Use the source side as the canonical "did this pair carry shares?"
    // signal; fall back to dest if source happens to be null.
    const existingQty = existingSourceQty ?? existingDestQty;
    const existingDestQtyOrSource = existingDestQty ?? existingSourceQty;
    if (existingSourceName && existingQty != null && existingQty > 0) {
      // Account swap detection — if either account changed we must re-resolve.
      const accountsChanged =
        fromAcct.id !== pair.source.accountId || toAcct.id !== pair.destination.accountId;
      if (accountsChanged) {
        const fromHoldingId = await findHoldingIdByAccountAndName(userId, dek, fromAcct.id, existingSourceName);
        if (fromHoldingId == null) {
          return {
            ok: false,
            code: "holding-not-found",
            message: `Holding "${existingSourceName}" not found in new source account "${fromAcct.name}". Pass holdingName=null to clear the in-kind side.`,
            side: "source",
          };
        }
        const resolver = await buildHoldingResolver(userId, dek);
        const toHoldingId = await resolver.resolve(toAcct.id, existingDestName ?? existingSourceName);
        resolvedHolding = {
          fromHoldingId,
          toHoldingId: toHoldingId ?? null,
          quantity: existingQty,
          destQuantity: existingDestQtyOrSource ?? existingQty,
          name: existingSourceName,
          destName: existingDestName ?? existingSourceName,
          touched: true,
        };
      } else {
        // Same accounts: just preserve the current FK + quantity.
        resolvedHolding = {
          fromHoldingId: pair.source.portfolioHoldingId ?? null,
          toHoldingId: pair.destination.portfolioHoldingId ?? null,
          quantity: existingQty,
          destQuantity: existingDestQtyOrSource ?? existingQty,
          name: existingSourceName,
          destName: existingDestName ?? existingSourceName,
          touched: false,
        };
      }
    } else {
      resolvedHolding = {
        fromHoldingId: null,
        toHoldingId: null,
        quantity: null,
        destQuantity: null,
        name: null,
        destName: null,
        touched: false,
      };
    }
  }

  try {
    await db.transaction(async (tx) => {
      const sourceUpdate = encryptTxWrite(dek, {
        payee: sourcePayee,
        note,
        tags,
      });
      const destUpdate = encryptTxWrite(dek, {
        payee: destPayee,
        note,
        tags,
      });

      const sourceHoldingPatch = resolvedHolding.touched
        ? {
            portfolioHoldingId: resolvedHolding.fromHoldingId,
            quantity:
              resolvedHolding.quantity != null
                ? -Math.abs(resolvedHolding.quantity)
                : null,
          }
        : {};
      const destHoldingPatch = resolvedHolding.touched
        ? {
            portfolioHoldingId: resolvedHolding.toHoldingId,
            // destQuantity may differ from source quantity (split / merger /
            // share-class conversion). Falls back to quantity when null.
            quantity:
              resolvedHolding.destQuantity != null
                ? Math.abs(resolvedHolding.destQuantity)
                : resolvedHolding.quantity != null
                  ? Math.abs(resolvedHolding.quantity)
                  : null,
          }
        : {};

      await tx
        .update(schema.transactions)
        .set({
          date,
          accountId: fromAcct.id,
          currency: fromCurrency,
          amount: -sentAmount,
          enteredCurrency: fromCurrency,
          enteredAmount: -sentAmount,
          enteredFxRate: 1,
          // Issue #28: bump audit timestamp on every transfer-leg UPDATE.
          // `source` is preserved (INSERT-only).
          updatedAt: sql`NOW()`,
          ...sourceHoldingPatch,
          ...sourceUpdate,
        })
        .where(
          and(
            eq(schema.transactions.id, pair.source.id),
            eq(schema.transactions.userId, userId),
          ),
        );

      await tx
        .update(schema.transactions)
        .set({
          date,
          accountId: toAcct.id,
          currency: toCurrency,
          amount: receivedAmount,
          enteredCurrency: fromCurrency,
          enteredAmount: sentAmount,
          enteredFxRate,
          updatedAt: sql`NOW()`,
          ...destHoldingPatch,
          ...destUpdate,
        })
        .where(
          and(
            eq(schema.transactions.id, pair.destination.id),
            eq(schema.transactions.userId, userId),
          ),
        );
    });
  } catch (err) {
    return {
      ok: false,
      code: "invalid-amount",
      message: err instanceof Error ? err.message : "Transfer update failed",
    };
  }

  invalidateUserTxCache(userId);

  return {
    ok: true,
    linkId: pair.linkId,
    fromTransactionId: pair.source.id,
    toTransactionId: pair.destination.id,
    fromAmount: -sentAmount,
    fromCurrency,
    toAmount: receivedAmount,
    toCurrency,
    enteredFxRate,
    isCrossCurrency,
    ...(resolvedHolding.fromHoldingId != null &&
    resolvedHolding.toHoldingId != null &&
    resolvedHolding.quantity != null &&
    resolvedHolding.name != null
      ? {
          holding: {
            name: resolvedHolding.name,
            destName: resolvedHolding.destName ?? resolvedHolding.name,
            quantity: resolvedHolding.quantity,
            destQuantity: resolvedHolding.destQuantity ?? resolvedHolding.quantity,
            fromHoldingId: resolvedHolding.fromHoldingId,
            toHoldingId: resolvedHolding.toHoldingId,
          },
        }
      : {}),
  };
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteTransferPair(
  opts: DeleteTransferOpts,
): Promise<{ ok: true; linkId: string; deletedCount: number } | TransferPairFail> {
  const pair = await loadTransferPair(opts.userId, null, {
    linkId: opts.linkId,
    transactionId: opts.transactionId,
  });
  if (!pair) {
    return {
      ok: false,
      code: "not-a-transfer-pair",
      message: "No transfer pair found for the given linkId/transactionId",
    };
  }

  // Use a SQL DELETE keyed on link_id + user_id so the operation is single-
  // statement atomic. (db.transaction would also work; prefer the simpler
  // path when both branches of the pair share an indexed key.)
  const result = await db
    .delete(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, opts.userId),
        eq(schema.transactions.linkId, pair.linkId),
      ),
    );

  invalidateUserTxCache(opts.userId);

  // Drizzle PG returns { rowCount }; guard for unknown driver shapes.
  const rowCount =
    result && typeof result === "object" && "rowCount" in result && typeof (result as { rowCount: unknown }).rowCount === "number"
      ? (result as { rowCount: number }).rowCount
      : 2;

  return { ok: true, linkId: pair.linkId, deletedCount: rowCount };
}

// ─── SQL bridge for stdio MCP (raw pg.Pool) ─────────────────────────────────
//
// The stdio MCP server runs in a separate Node process with its own pg.Pool
// and a SQLite-shaped pg-compat layer (pg-compat.ts). It does NOT have
// Drizzle. The pg-compat `transaction()` helper has a footgun — its `fn()`
// body acquires fresh pool clients via `prepare()` so DML inside the body
// runs OUTSIDE the BEGIN/COMMIT. We sidestep that by using the underlying
// `pg.Pool` directly here so all writes in a single transfer go through one
// client connection.
//
// Same external semantics as the Drizzle helpers above (atomic, four-check
// enforced, payee/note/tags encrypted when a DEK is present). Read paths
// share the helper logic; only the data-access shape differs.

type SqlClient = {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  release(): void;
};

type SqlPool = {
  connect(): Promise<SqlClient>;
};

async function withClient<T>(pool: SqlPool, fn: (c: SqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withTx<T>(pool: SqlPool, fn: (c: SqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore — the original error is what we care about
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── ViaSql: load ──────────────────────────────────────────────────────────

export async function loadTransferPairViaSql(
  pool: Pool,
  userId: string,
  dek: Buffer | null,
  by: { linkId?: string; transactionId?: number },
): Promise<TransferPair | null> {
  let resolvedLinkId: string | null = null;

  if (by.linkId) {
    resolvedLinkId = by.linkId;
  } else if (by.transactionId != null) {
    const r = await withClient(pool as unknown as SqlPool, (c) =>
      c.query<{ link_id: string | null }>(
        `SELECT link_id FROM transactions WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [by.transactionId, userId],
      ),
    );
    if (!r.rows.length || !r.rows[0].link_id) return null;
    resolvedLinkId = r.rows[0].link_id;
  } else {
    return null;
  }

  type Row = {
    id: number;
    date: string;
    account_id: number;
    account_name: string | null;
    account_currency: string | null;
    category_id: number;
    category_name: string | null;
    category_type: string | null;
    amount: number;
    currency: string;
    entered_amount: number | null;
    entered_currency: string | null;
    entered_fx_rate: number | null;
    payee: string | null;
    note: string | null;
    tags: string | null;
    link_id: string | null;
  };

  const rs = await withClient(pool as unknown as SqlPool, (c) =>
    c.query<Row>(
      `SELECT t.id, t.date, t.account_id, a.name AS account_name, a.currency AS account_currency,
              t.category_id, c.name AS category_name, c.type AS category_type,
              t.amount, t.currency,
              t.entered_amount, t.entered_currency, t.entered_fx_rate,
              t.payee, t.note, t.tags, t.link_id
         FROM transactions t
         LEFT JOIN accounts a   ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = $1 AND t.link_id = $2`,
      [userId, resolvedLinkId],
    ),
  );

  const rows = rs.rows;
  if (rows.length !== 2) return null;
  if (!rows.every((r) => r.category_type === "R")) return null;
  if (rows[0].account_id === rows[1].account_id) return null;

  // Decrypt encrypted text fields. Soft-fallback when DEK is null.
  const dec = (v: string | null): string | null => {
    if (v == null) return null;
    if (!dek) return v;
    try {
      return decryptField(dek, v);
    } catch {
      return v;
    }
  };

  const decoded = rows.map((r) => ({
    ...r,
    payee: dec(r.payee),
    note: dec(r.note),
    tags: dec(r.tags),
  }));

  let sourceRow = decoded.find((r) => r.amount < 0) ?? null;
  let destRow = decoded.find((r) => r.amount >= 0) ?? null;
  if (!sourceRow || !destRow || sourceRow.id === destRow.id) {
    const sorted = [...decoded].sort((a, b) => a.id - b.id);
    sourceRow = sorted[0];
    destRow = sorted[1];
  }

  const toLeg = (r: typeof decoded[number]): TransferLeg => ({
    id: r.id,
    date: r.date,
    accountId: r.account_id,
    accountName: r.account_name,
    accountCurrency: (r.account_currency ?? r.currency ?? "CAD").toUpperCase(),
    categoryId: r.category_id,
    categoryName: r.category_name,
    amount: r.amount,
    currency: r.currency,
    enteredAmount: r.entered_amount,
    enteredCurrency: r.entered_currency,
    enteredFxRate: r.entered_fx_rate,
    payee: r.payee,
    note: r.note,
    tags: r.tags,
    linkId: r.link_id ?? "",
    // Stdio path doesn't query the holding JOIN — leave these null. The
    // stdio update_transfer tool doesn't expose holding mutation in v1, so
    // the only consumer that would care (the unified UI's edit-pair path)
    // never goes through ViaSql.
    portfolioHoldingId: null,
    portfolioHoldingName: null,
    quantity: null,
  });

  return {
    linkId: resolvedLinkId,
    source: toLeg(sourceRow!),
    destination: toLeg(destRow!),
  };
}

/**
 * Resolve (or auto-create) the Transfer category via raw SQL, sharing the
 * caller's transaction client so the auto-create commits atomically with
 * the rest of the transfer write. Mirrors the Drizzle variant.
 */
async function resolveTransferCategoryIdViaSql(
  client: SqlClient,
  userId: string,
  dek: Buffer | null,
): Promise<number> {
  const rows = await client.query<{ id: number; name: string | null }>(
    `SELECT id, name FROM categories WHERE user_id = $1 AND type = 'R' ORDER BY id`,
    [userId],
  );
  const preferred = rows.rows.find(
    (r) => (r.name ?? "").trim().toLowerCase() === "transfer",
  );
  if (preferred) return preferred.id;
  if (rows.rows.length > 0) return rows.rows[0].id;

  const ct = dek ? encryptField(dek, "Transfer") : null;
  const lookup = dek ? nameLookup(dek, "Transfer") : null;
  const ins = await client.query<{ id: number }>(
    `INSERT INTO categories (user_id, type, "group", name, name_ct, name_lookup)
     VALUES ($1, 'R', 'Transfer', 'Transfer', $2, $3)
     RETURNING id`,
    [userId, ct, lookup],
  );
  return ins.rows[0].id;
}

// ─── ViaSql: create ────────────────────────────────────────────────────────

export async function createTransferPairViaSql(
  pool: Pool,
  userId: string,
  dek: Buffer | null,
  opts: Omit<CreateTransferOpts, "userId" | "dek">,
): Promise<TransferPairResult> {
  // In-kind validation up front. Both fields move together.
  const wantsHolding =
    (opts.holdingName != null && opts.holdingName.trim() !== "") ||
    (opts.quantity != null && opts.quantity !== 0);
  if (wantsHolding) {
    if (!opts.holdingName || opts.holdingName.trim() === "") {
      return { ok: false, code: "invalid-holding-spec", message: "holdingName is required when quantity is set" };
    }
    if (opts.quantity == null || !Number.isFinite(opts.quantity) || opts.quantity <= 0) {
      return { ok: false, code: "invalid-amount", message: "quantity must be a positive number when holdingName is set" };
    }
    if (
      opts.destQuantity !== undefined &&
      (!Number.isFinite(opts.destQuantity) || opts.destQuantity <= 0)
    ) {
      return { ok: false, code: "invalid-amount", message: "destQuantity must be a positive number when provided" };
    }
  }

  if (!Number.isFinite(opts.enteredAmount) || opts.enteredAmount < 0) {
    return { ok: false, code: "invalid-amount", message: "enteredAmount must be a non-negative number" };
  }
  if (!wantsHolding && opts.enteredAmount === 0) {
    return { ok: false, code: "invalid-amount", message: "enteredAmount must be > 0 (or supply holdingName + quantity for an in-kind transfer)" };
  }
  if (
    opts.receivedAmount !== undefined &&
    (!Number.isFinite(opts.receivedAmount) || opts.receivedAmount < 0)
  ) {
    return { ok: false, code: "invalid-amount", message: "receivedAmount must be a non-negative number when provided" };
  }
  // Same-account is allowed only for in-kind moves (rebalance between two
  // holdings inside the same brokerage). Pure cash same-account is a no-op.
  if (opts.fromAccountId === opts.toAccountId && !wantsHolding) {
    return { ok: false, code: "same-account", message: "From and to accounts must differ for a cash transfer" };
  }

  const date = opts.date ?? todayISO();

  const accountsRows = await withClient(pool as unknown as SqlPool, (c) =>
    c.query<{ id: number; name: string | null; currency: string | null }>(
      `SELECT id, name, currency FROM accounts
        WHERE user_id = $1 AND id = ANY($2::int[])`,
      [userId, [opts.fromAccountId, opts.toAccountId]],
    ),
  );
  const fromAcct = accountsRows.rows.find((a) => a.id === opts.fromAccountId);
  const toAcct = accountsRows.rows.find((a) => a.id === opts.toAccountId);
  if (!fromAcct) return { ok: false, code: "account-not-found", message: `Source account #${opts.fromAccountId} not found`, side: "source" };
  if (!toAcct) return { ok: false, code: "account-not-found", message: `Destination account #${opts.toAccountId} not found`, side: "destination" };

  const fromCurrency = (fromAcct.currency ?? "CAD").toUpperCase();
  const toCurrency = (toAcct.currency ?? "CAD").toUpperCase();
  const isCrossCurrency = fromCurrency !== toCurrency;
  const sentAmount = round2(opts.enteredAmount);

  let receivedAmount: number;
  let enteredFxRate: number;
  if (sentAmount === 0) {
    receivedAmount = 0;
    enteredFxRate = 1;
  } else if (!isCrossCurrency) {
    receivedAmount = sentAmount;
    enteredFxRate = 1;
  } else if (opts.receivedAmount !== undefined) {
    receivedAmount = round2(opts.receivedAmount);
    enteredFxRate = sentAmount === 0 ? 1 : receivedAmount / sentAmount;
  } else {
    const conv = await resolveTxAmountsCore({
      accountCurrency: toCurrency,
      date,
      userId,
      enteredAmount: sentAmount,
      enteredCurrency: fromCurrency,
    });
    if (!conv.ok) {
      return {
        ok: false,
        code: conv.code === "fx-currency-needs-override" ? "fx-currency-needs-override" : "invalid-amount",
        message: conv.message,
        side: "destination",
        currency: conv.currency,
      };
    }
    receivedAmount = conv.amount;
    enteredFxRate = conv.enteredFxRate;
  }

  // In-kind holding resolution (raw SQL — stdio path has no Drizzle).
  // Source MUST exist; destination is auto-created if missing. Stdio runs
  // dek-less, so we only key by plaintext name on accounts the user has
  // touched in this session.
  let holdingResolved:
    | {
        fromHoldingId: number;
        toHoldingId: number;
        quantity: number;
        destQuantity: number;
        name: string;
        destName: string;
      }
    | null = null;
  if (wantsHolding) {
    if (
      opts.destQuantity !== undefined &&
      (!Number.isFinite(opts.destQuantity) || opts.destQuantity <= 0)
    ) {
      return { ok: false, code: "invalid-amount", message: "destQuantity must be a positive number when provided" };
    }
    const trimmedName = opts.holdingName!.trim();
    const trimmedDestName =
      opts.destHoldingName != null && opts.destHoldingName.trim() !== ""
        ? opts.destHoldingName.trim()
        : trimmedName;
    const fromHoldingId = await findHoldingIdViaSql(
      pool as unknown as SqlPool,
      userId,
      dek,
      fromAcct.id,
      trimmedName,
    );
    if (fromHoldingId == null) {
      return {
        ok: false,
        code: "holding-not-found",
        message: `Holding "${trimmedName}" not found in source account "${fromAcct.name}".`,
        side: "source",
      };
    }
    // Issue #92: strict find-only on the destination side (mirrors the
    // Drizzle path). The previous findOrCreateHoldingViaSql auto-created a
    // Cash sleeve here, which silently masked typos and surfaced a raw
    // 23505 duplicate-key error when a partial-cash row already existed.
    const toHoldingId = await findHoldingIdViaSql(
      pool as unknown as SqlPool,
      userId,
      dek,
      toAcct.id,
      trimmedDestName,
    );
    if (toHoldingId == null) {
      return {
        ok: false,
        code: "no-cash-holding",
        message: `No holding named "${trimmedDestName}" found in destination account "${toAcct.name}". Create it first: add_portfolio_holding(account="${toAcct.name}", name="${trimmedDestName}", currency="${toCurrency}")`,
        side: "destination",
      };
    }
    if (fromHoldingId === toHoldingId) {
      return {
        ok: false,
        code: "invalid-holding-spec",
        message:
          fromAcct.id === toAcct.id
            ? `Source and destination both point at "${trimmedName}" in "${fromAcct.name}" — pick a different destination holding.`
            : `Source and destination resolve to the same holding row — pick a different destination holding name.`,
      };
    }
    holdingResolved = {
      fromHoldingId,
      toHoldingId,
      quantity: opts.quantity!,
      destQuantity: opts.destQuantity != null ? opts.destQuantity : opts.quantity!,
      name: trimmedName,
      destName: trimmedDestName,
    };
  }

  const linkId = randomUUID();
  const sourcePayee = defaultPayee("out", toAcct.name);
  const destPayee = defaultPayee("in", fromAcct.name);
  const note = opts.note ?? "";
  const tags = applySourceTag(opts.tags ?? "", opts.source);
  const enc = (v: string) => (dek ? encryptField(dek, v) : v);

  // Investment-account constraint (strict — issue #22): same refusal as
  // the Drizzle path. Stdio MCP runs without holding parameters on
  // record_transfer's cash path, so a transfer into an investment account
  // either supplies in-kind `holding`+`quantity` or hits the throw and gets
  // mapped to a friendly tool error by the MCP wrapper. The Drizzle/HTTP
  // path additionally accepts `fromHoldingId` / `toHoldingId` cash pins,
  // validated against the leg's account ownership before use.
  if (opts.fromHoldingId != null && !(await holdingBelongsToAccountViaSql(pool as unknown as SqlPool, userId, opts.fromHoldingId, fromAcct.id))) {
    return {
      ok: false,
      code: "holding-not-found",
      message: `Source holding #${opts.fromHoldingId} not found in account "${fromAcct.name}".`,
      side: "source",
    };
  }
  if (opts.toHoldingId != null && !(await holdingBelongsToAccountViaSql(pool as unknown as SqlPool, userId, opts.toHoldingId, toAcct.id))) {
    return {
      ok: false,
      code: "holding-not-found",
      message: `Destination holding #${opts.toHoldingId} not found in account "${toAcct.name}".`,
      side: "destination",
    };
  }
  const fromHoldingId = holdingResolved?.fromHoldingId ?? opts.fromHoldingId ?? null;
  const toHoldingId = holdingResolved?.toHoldingId ?? opts.toHoldingId ?? null;
  if (fromHoldingId == null && (await isInvestmentAccount(userId, fromAcct.id))) {
    throw new InvestmentHoldingRequiredError(fromAcct.id);
  }
  if (toHoldingId == null && (await isInvestmentAccount(userId, toAcct.id))) {
    throw new InvestmentHoldingRequiredError(toAcct.id);
  }

  let fromTransactionId = 0;
  let toTransactionId = 0;
  try {
    await withTx(pool as unknown as SqlPool, async (client) => {
      const categoryId = await resolveTransferCategoryIdViaSql(client, userId, dek);

      // Issue #28: both legs share the writer-surface attribution.
      const txSource: TransactionSource = opts.txSource ?? "manual";
      const sourceIns = await client.query<{ id: number }>(
        `INSERT INTO transactions (
            user_id, date, account_id, category_id,
            currency, amount,
            entered_currency, entered_amount, entered_fx_rate,
            payee, note, tags, link_id,
            portfolio_holding_id, quantity,
            source
         ) VALUES (
            $1, $2, $3, $4,
            $5, $6,
            $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15,
            $16
         ) RETURNING id`,
        [
          userId, date, fromAcct.id, categoryId,
          fromCurrency, -sentAmount,
          fromCurrency, -sentAmount, 1,
          enc(sourcePayee), enc(note), enc(tags), linkId,
          fromHoldingId,
          holdingResolved ? -Math.abs(holdingResolved.quantity) : null,
          txSource,
        ],
      );
      fromTransactionId = sourceIns.rows[0].id;

      const destIns = await client.query<{ id: number }>(
        `INSERT INTO transactions (
            user_id, date, account_id, category_id,
            currency, amount,
            entered_currency, entered_amount, entered_fx_rate,
            payee, note, tags, link_id,
            portfolio_holding_id, quantity,
            source
         ) VALUES (
            $1, $2, $3, $4,
            $5, $6,
            $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15,
            $16
         ) RETURNING id`,
        [
          userId, date, toAcct.id, categoryId,
          toCurrency, receivedAmount,
          fromCurrency, sentAmount, enteredFxRate,
          enc(destPayee), enc(note), enc(tags), linkId,
          toHoldingId,
          // destQuantity may differ from source quantity (split / merger).
          holdingResolved ? Math.abs(holdingResolved.destQuantity) : null,
          txSource,
        ],
      );
      toTransactionId = destIns.rows[0].id;
    });
  } catch (err) {
    return {
      ok: false,
      code: "invalid-amount",
      message: err instanceof Error ? err.message : "Transfer write failed",
    };
  }

  invalidateUserTxCache(userId);

  return {
    ok: true,
    linkId,
    fromTransactionId,
    toTransactionId,
    fromAmount: -sentAmount,
    fromCurrency,
    toAmount: receivedAmount,
    toCurrency,
    enteredFxRate,
    isCrossCurrency,
    ...(holdingResolved
      ? {
          holding: {
            name: holdingResolved.name,
            destName: holdingResolved.destName,
            quantity: holdingResolved.quantity,
            destQuantity: holdingResolved.destQuantity,
            fromHoldingId: holdingResolved.fromHoldingId,
            toHoldingId: holdingResolved.toHoldingId,
          },
        }
      : {}),
  };
}

/**
 * Raw-SQL mirror of {@link holdingBelongsToAccount} for the stdio path.
 */
async function holdingBelongsToAccountViaSql(
  pool: SqlPool,
  userId: string,
  holdingId: number,
  accountId: number,
): Promise<boolean> {
  const r = await withClient(pool, (c) =>
    c.query<{ id: number }>(
      `SELECT id FROM portfolio_holdings
        WHERE id = $1 AND user_id = $2 AND account_id = $3
        LIMIT 1`,
      [holdingId, userId, accountId],
    ),
  );
  return r.rows.length > 0;
}

/**
 * Strict source-side holding lookup via raw SQL. Mirror of
 * {@link findHoldingIdByAccountAndName} for the stdio path.
 */
async function findHoldingIdViaSql(
  pool: SqlPool,
  userId: string,
  dek: Buffer | null,
  accountId: number,
  name: string,
): Promise<number | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const plain = await withClient(pool, (c) =>
    c.query<{ id: number }>(
      `SELECT id FROM portfolio_holdings
        WHERE user_id = $1 AND account_id = $2 AND name = $3
        LIMIT 1`,
      [userId, accountId, trimmed],
    ),
  );
  if (plain.rows.length) return plain.rows[0].id;
  if (dek) {
    const lookup = nameLookup(dek, trimmed);
    const enc = await withClient(pool, (c) =>
      c.query<{ id: number }>(
        `SELECT id FROM portfolio_holdings
          WHERE user_id = $1 AND account_id = $2 AND name_lookup = $3
          LIMIT 1`,
        [userId, accountId, lookup],
      ),
    );
    if (enc.rows.length) return enc.rows[0].id;
  }
  return null;
}

// Issue #92: findOrCreateHoldingViaSql was deleted. The transfer path no
// longer auto-creates a destination holding row — both legs MUST exist via
// add_portfolio_holding before record_transfer / record_trade. The Drizzle
// equivalent (buildHoldingResolver's auto-create branch) is still used by
// the import pipeline, which has its own resolver-report UX.

// ─── ViaSql: update ────────────────────────────────────────────────────────

export async function updateTransferPairViaSql(
  pool: Pool,
  userId: string,
  dek: Buffer | null,
  opts: Omit<UpdateTransferOpts, "userId" | "dek">,
): Promise<TransferPairResult> {
  const pair = await loadTransferPairViaSql(pool, userId, dek, {
    linkId: opts.linkId,
    transactionId: opts.transactionId,
  });
  if (!pair) {
    return { ok: false, code: "not-a-transfer-pair", message: "No transfer pair found for the given linkId/transactionId" };
  }

  const desiredFromId = opts.fromAccountId ?? pair.source.accountId;
  const desiredToId = opts.toAccountId ?? pair.destination.accountId;
  // Same-account allowed only when the existing pair carries in-kind data
  // (rebalance within one brokerage). Same-account pure cash is rejected.
  const pairWasInKind =
    (pair.source.portfolioHoldingId != null && (pair.source.quantity ?? 0) !== 0) ||
    (pair.destination.portfolioHoldingId != null && (pair.destination.quantity ?? 0) !== 0);
  if (desiredFromId === desiredToId && !pairWasInKind) {
    return { ok: false, code: "same-account", message: "From and to accounts must differ for a cash transfer" };
  }

  const accountsRows = await withClient(pool as unknown as SqlPool, (c) =>
    c.query<{ id: number; name: string | null; currency: string | null }>(
      `SELECT id, name, currency FROM accounts
        WHERE user_id = $1 AND id = ANY($2::int[])`,
      [userId, [desiredFromId, desiredToId]],
    ),
  );
  const fromAcct = accountsRows.rows.find((a) => a.id === desiredFromId);
  const toAcct = accountsRows.rows.find((a) => a.id === desiredToId);
  if (!fromAcct) return { ok: false, code: "account-not-found", message: `Source account #${desiredFromId} not found`, side: "source" };
  if (!toAcct) return { ok: false, code: "account-not-found", message: `Destination account #${desiredToId} not found`, side: "destination" };

  const fromCurrency = (fromAcct.currency ?? "CAD").toUpperCase();
  const toCurrency = (toAcct.currency ?? "CAD").toUpperCase();
  const isCrossCurrency = fromCurrency !== toCurrency;
  const enteredAmount = opts.enteredAmount ?? Math.abs(pair.source.amount);
  if (!Number.isFinite(enteredAmount) || enteredAmount < 0) {
    return { ok: false, code: "invalid-amount", message: "enteredAmount must be a non-negative number" };
  }
  const sentAmount = round2(enteredAmount);
  const date = opts.date ?? pair.source.date;

  const currenciesUnchanged =
    fromCurrency === pair.source.currency.toUpperCase() &&
    toCurrency === pair.destination.currency.toUpperCase();

  let receivedAmount: number;
  let enteredFxRate: number;
  if (sentAmount === 0) {
    receivedAmount = 0;
    enteredFxRate = 1;
  } else if (!isCrossCurrency) {
    receivedAmount = sentAmount;
    enteredFxRate = 1;
  } else if (opts.receivedAmount !== undefined) {
    if (!Number.isFinite(opts.receivedAmount) || opts.receivedAmount < 0) {
      return { ok: false, code: "invalid-amount", message: "receivedAmount must be a non-negative number when provided" };
    }
    receivedAmount = round2(opts.receivedAmount);
    enteredFxRate = receivedAmount / sentAmount;
  } else if (
    currenciesUnchanged &&
    opts.enteredAmount === undefined &&
    pair.destination.enteredFxRate != null &&
    Number.isFinite(pair.destination.enteredFxRate)
  ) {
    enteredFxRate = pair.destination.enteredFxRate;
    receivedAmount = round2(Math.abs(pair.destination.amount));
  } else {
    const conv = await resolveTxAmountsCore({
      accountCurrency: toCurrency,
      date,
      userId,
      enteredAmount: sentAmount,
      enteredCurrency: fromCurrency,
    });
    if (!conv.ok) {
      return {
        ok: false,
        code: conv.code === "fx-currency-needs-override" ? "fx-currency-needs-override" : "invalid-amount",
        message: conv.message,
        side: "destination",
        currency: conv.currency,
      };
    }
    receivedAmount = conv.amount;
    enteredFxRate = conv.enteredFxRate;
  }

  const note = opts.note ?? pair.source.note ?? "";
  const tags = opts.tags ?? pair.source.tags ?? "";
  const sourcePayee = defaultPayee("out", toAcct.name);
  const destPayee = defaultPayee("in", fromAcct.name);
  const enc = (v: string) => (dek ? encryptField(dek, v) : v);

  try {
    await withTx(pool as unknown as SqlPool, async (client) => {
      // Issue #28: every UPDATE bumps updated_at. `source` stays untouched
      // (INSERT-only). Both legs of the transfer pair get the same bump.
      await client.query(
        `UPDATE transactions
            SET date = $1, account_id = $2, currency = $3, amount = $4,
                entered_currency = $5, entered_amount = $6, entered_fx_rate = $7,
                payee = $8, note = $9, tags = $10,
                updated_at = NOW()
          WHERE id = $11 AND user_id = $12`,
        [
          date, fromAcct.id, fromCurrency, -sentAmount,
          fromCurrency, -sentAmount, 1,
          enc(sourcePayee), enc(note), enc(tags),
          pair.source.id, userId,
        ],
      );
      await client.query(
        `UPDATE transactions
            SET date = $1, account_id = $2, currency = $3, amount = $4,
                entered_currency = $5, entered_amount = $6, entered_fx_rate = $7,
                payee = $8, note = $9, tags = $10,
                updated_at = NOW()
          WHERE id = $11 AND user_id = $12`,
        [
          date, toAcct.id, toCurrency, receivedAmount,
          fromCurrency, sentAmount, enteredFxRate,
          enc(destPayee), enc(note), enc(tags),
          pair.destination.id, userId,
        ],
      );
    });
  } catch (err) {
    return {
      ok: false,
      code: "invalid-amount",
      message: err instanceof Error ? err.message : "Transfer update failed",
    };
  }

  invalidateUserTxCache(userId);

  return {
    ok: true,
    linkId: pair.linkId,
    fromTransactionId: pair.source.id,
    toTransactionId: pair.destination.id,
    fromAmount: -sentAmount,
    fromCurrency,
    toAmount: receivedAmount,
    toCurrency,
    enteredFxRate,
    isCrossCurrency,
  };
}

// ─── ViaSql: delete ────────────────────────────────────────────────────────

export async function deleteTransferPairViaSql(
  pool: Pool,
  userId: string,
  by: { linkId?: string; transactionId?: number },
): Promise<{ ok: true; linkId: string; deletedCount: number } | TransferPairFail> {
  const pair = await loadTransferPairViaSql(pool, userId, null, by);
  if (!pair) {
    return {
      ok: false,
      code: "not-a-transfer-pair",
      message: "No transfer pair found for the given linkId/transactionId",
    };
  }
  const result = await withClient(pool as unknown as SqlPool, (c) =>
    c.query(
      `DELETE FROM transactions WHERE user_id = $1 AND link_id = $2`,
      [userId, pair.linkId],
    ),
  );
  invalidateUserTxCache(userId);
  return { ok: true, linkId: pair.linkId, deletedCount: result.rowCount ?? 2 };
}
