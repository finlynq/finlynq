/**
 * FINLYNQ-84 — Transaction rules v2: multi-condition matching + richer actions.
 *
 * Zod discriminated unions for the new `transaction_rules` shape. Replaces the
 * legacy flat columns (`matchField`, `matchType`, `matchValue`, `assignCategoryId`,
 * `assignTags`, `renameTo`) with JSONB `conditions` (AND-only group of typed
 * conditions) + JSONB `actions` (typed action array).
 *
 * Load-bearing invariants enforced here:
 * - Condition composition is AND-only (`ConditionGroup.all[]`). No nested OR
 *   in v2; deferred to a future iteration if real-world rules demand it.
 * - `set_portfolio_holding` is assign-existing-id-only (no auto-create branch).
 *   Sidesteps the `holding_accounts` dual-write invariant — that's the job of
 *   `add_portfolio_holding`.
 * - `create_transfer.linkId` is NOT an action-config field. `link_id` is
 *   server-generated only (minted inside `createTransferPair`). The action
 *   carries only the destination account.
 *
 * See plan: pf-app/plan/finlynq-84-rules-v2.md
 * See living doc (post-ship): pf-app/docs/transaction-rules-v2.md
 */
import { z } from "zod";
import { StringOp } from "@/lib/schemas/rule-primitives";
const AmountOp = z.enum(["gt", "lt", "eq"]);
const SetOp = z.enum(["is", "is_not"]);

const StringCondition = z.object({
  field: z.enum(["payee", "note", "tags"]),
  op: StringOp,
  value: z.string().min(1).max(500),
});

const AmountConditionSingle = z.object({
  field: z.literal("amount"),
  op: AmountOp,
  value: z.number(),
});

const AmountConditionBetween = z.object({
  field: z.literal("amount"),
  op: z.literal("between"),
  min: z.number(),
  max: z.number(),
});

const AccountCondition = z.object({
  field: z.literal("account"),
  op: SetOp,
  accountId: z.number().int().positive(),
});

const CurrencyCondition = z.object({
  field: z.literal("currency"),
  op: SetOp,
  value: z.string().length(3).toUpperCase(),
});

const DateWeekdayCondition = z.object({
  field: z.literal("date"),
  op: z.literal("weekday"),
  weekday: z.number().int().min(0).max(6), // 0=Sun..6=Sat (UTC)
});

const DateDayOfMonthCondition = z.object({
  field: z.literal("date"),
  op: z.literal("day_of_month"),
  day: z.number().int().min(1).max(31),
});

const DateBetweenCondition = z.object({
  field: z.literal("date"),
  op: z.literal("between"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// FINLYNQ-208 — investment-import captured fields as rule conditions.
// `ticker` / `security_name` are SENSITIVE free-text (encrypted at rest on
// bank_transactions, FINLYNQ-195) so their condition `.value` is encrypted by
// rules/crypto.ts exactly like payee/note/tags (see STRING_CONDITION_FIELDS).
// `quantity` mirrors the `amount` condition shape (single op + between).
const TickerCondition = z.object({
  field: z.literal("ticker"),
  op: StringOp,
  value: z.string().min(1).max(100),
});

const SecurityNameCondition = z.object({
  field: z.literal("security_name"),
  op: StringOp,
  value: z.string().min(1).max(200),
});

const QuantityConditionSingle = z.object({
  field: z.literal("quantity"),
  op: AmountOp,
  value: z.number(),
});

const QuantityConditionBetween = z.object({
  field: z.literal("quantity"),
  op: z.literal("between"),
  min: z.number(),
  max: z.number(),
});

// GH #464 — the bank's merchant category code (ISO 18245, 4 digits). Plain
// text, so its `.value` is NOT encrypted by rules/crypto.ts. `is` = one code,
// `starts_with` = a prefix ("581" covers 5811-5814), `in` = a list of codes
// separated by commas or spaces.
const MerchantCategoryCodeCondition = z.object({
  field: z.literal("merchant_category_code"),
  op: z.enum(["is", "starts_with", "in"]),
  value: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^[\d\s,;]+$/, "Merchant category codes are digits"),
});

// FINLYNQ-84 cycle 2 (2026-05-21): Zod v4 rejects discriminatedUnion when
// two branches share a discriminator value. The original schema had
// `field: "amount"` ×2 (single + between) and `field: "date"` ×3 (weekday +
// day_of_month + between), which threw at union-build time and broke every
// .safeParse() on the rule endpoints. Switched to top-level z.union so the
// 8 leaf schemas can be tried in order. Tradeoff: error messages on parse
// failure become "no schema matched" instead of "field=amount but op=foo
// invalid"; existing tests don't depend on the Zod error fingerprint
// (they assert HTTP status codes + body presence), so the trade is fine.
export const Condition = z.union([
  StringCondition,
  AmountConditionSingle,
  AmountConditionBetween,
  AccountCondition,
  CurrencyCondition,
  DateWeekdayCondition,
  DateDayOfMonthCondition,
  DateBetweenCondition,
  TickerCondition,
  SecurityNameCondition,
  QuantityConditionSingle,
  QuantityConditionBetween,
  MerchantCategoryCodeCondition,
]);
export type Condition = z.infer<typeof Condition>;

export const ConditionGroup = z.object({
  all: z.array(Condition).min(1).max(20),
});
export type ConditionGroup = z.infer<typeof ConditionGroup>;

// FINLYNQ-208 — investment reconciliation rules.
//
// `record_investment_op` lets a user-authored rule turn a matched investment
// bank row into a real lot-aware portfolio operation via operations.ts. The op
// type is USER-CHOSEN (no inference) and its numeric params bind to row
// "variables" captured at import (FINLYNQ-195): the row's total `amount`, its
// `quantity`, and (future) a captured `price` per unit. `VarSource` declares
// WHERE each param comes from — a captured row field or a fixed value — so the
// executor can derive a trade from ANY TWO of {amount, price, quantity} and
// compute the third (amount = price × qty). Lot allocation is ALWAYS automatic
// FIFO; the rule never selects lots (a later manual reallocation handles that).
export const VarSource = z.union([
  z.object({ from: z.enum(["row_amount", "row_quantity", "row_price"]) }),
  z.object({ from: z.literal("fixed"), value: z.number() }),
]);
export type VarSource = z.infer<typeof VarSource>;

/** The investment transaction types a rule action can record. Swap / in-kind
 *  transfer / FX conversion are deferred (they need two holdings / two
 *  currencies that don't map cleanly onto a single statement row). */
export const InvestmentOp = z.enum([
  "buy",
  "sell",
  "dividend",
  "interest",
  "fee",
  "deposit",
  "withdrawal",
]);
export type InvestmentOp = z.infer<typeof InvestmentOp>;

// Fields are intentionally OPTIONAL at the Zod layer — the editor seeds blank
// placeholders the user fills before submit (FINLYNQ-114 pattern). Per-op
// semantic requirements (e.g. buy needs a holding + qty + total; deposit needs
// a counterparty) are enforced by `validateInvestmentOpAction` at the write
// path and by the executor, NOT here.
const RecordInvestmentOpAction = z.object({
  kind: z.literal("record_investment_op"),
  op: InvestmentOp,
  /** The investment account the position / cash sleeve lives in. */
  investmentAccountId: z.number().int().positive(),
  /** Non-investment counterparty account for deposit / withdrawal (the
   *  bank/chequing side). Ignored by the other ops. */
  counterpartyAccountId: z.number().int().positive().optional(),
  /** Explicit existing position to trade (buy/sell/dividend/interest/fee). */
  holdingId: z.number().int().positive().optional(),
  /** Resolve (or create) the position from the bank row's captured ticker /
   *  security name instead of a fixed `holdingId`. */
  useRowTicker: z.boolean().optional(),
  /** Variable bindings — qty + total for buy/sell (any two of the three are
   *  enough); `total` doubles as the cash amount for dividend/interest/fee/
   *  deposit/withdrawal. */
  qty: VarSource.optional(),
  total: VarSource.optional(),
  price: VarSource.optional(),
  /** Income received AS SHARES — single-leg DRIP. Only meaningful for
   *  `dividend`/`interest`: when "shares", the income is recorded as SHARES on
   *  the resolved (required) position via `recordReinvestedIncomeInShares` —
   *  qty + total bind like a trade (any two of {qty,total,price}) — instead of
   *  crediting a cash sleeve. Absent / "cash" = the legacy cash-sleeve path. */
  settleAs: z.enum(["cash", "shares"]).optional(),
  /** Optional explicit category for the income/cash ops (dividend / interest /
   *  fee — applies in both cash and shares settle modes). When unset, the
   *  executor resolves the canonical income category by op kind (Dividends /
   *  Interest / Investment Fees). Ignored by buy/sell/deposit/withdrawal. */
  categoryId: z.number().int().positive().optional(),
});

export const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_category"), categoryId: z.number().int().positive() }),
  z.object({ kind: z.literal("set_tags"), tags: z.string().max(500) }),
  z.object({ kind: z.literal("rename_payee"), to: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("set_account"), accountId: z.number().int().positive() }),
  z.object({ kind: z.literal("set_entered_currency"), currency: z.string().length(3).toUpperCase() }),
  z.object({ kind: z.literal("set_portfolio_holding"), holdingId: z.number().int().positive() }),
  z.object({ kind: z.literal("create_transfer"), destAccountId: z.number().int().positive() }),
  RecordInvestmentOpAction,
]);
export type Action = z.infer<typeof Action>;

/** Narrowed alias for the investment-op action member. */
export type RecordInvestmentOpAction = Extract<Action, { kind: "record_investment_op" }>;

export const Rule = z.object({
  name: z.string().min(1).max(120),
  conditions: ConditionGroup,
  actions: z.array(Action).min(1).max(10),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
});
export type Rule = z.infer<typeof Rule>;

// ─── Typed factory maps (FINLYNQ-114) ────────────────────────────────────────
//
// When the rule editor switches a condition's `field` or an action's `kind`,
// it must reset the row to a fully-typed default for the NEW variant (not just
// patch the discriminator). Modeling these as typed factory maps gives each
// default a precise member type — a wrong field on a variant is now a compile
// error here, instead of being hidden behind `as unknown as Partial<…>` at the
// 12 call sites in `rule-editor-dialog.tsx`. The objects produced are
// byte-identical to what those casts produced, so the wire shape is unchanged.

/** Discriminate a Condition union member by its `field` literal. */
export type ConditionField = Condition["field"];

/** Discriminate an Action union member by its `kind` literal. */
export type ActionKind = Action["kind"];

/**
 * Default `Condition` for a freshly-selected field. The `amount` and `date`
 * fields have multiple op-variants in the union; the editor seeds the first
 * variant (single `amount` / `weekday` `date`) and the user refines `op` after.
 */
export const CONDITION_DEFAULTS: {
  payee: () => Extract<Condition, { field: "payee" | "note" | "tags" }>;
  note: () => Extract<Condition, { field: "payee" | "note" | "tags" }>;
  tags: () => Extract<Condition, { field: "payee" | "note" | "tags" }>;
  amount: () => Extract<Condition, { field: "amount" }>;
  account: (accountId: number) => Extract<Condition, { field: "account" }>;
  currency: () => Extract<Condition, { field: "currency" }>;
  date: () => Extract<Condition, { field: "date" }>;
  ticker: () => Extract<Condition, { field: "ticker" }>;
  security_name: () => Extract<Condition, { field: "security_name" }>;
  quantity: () => Extract<Condition, { field: "quantity" }>;
  merchant_category_code: () => Extract<Condition, { field: "merchant_category_code" }>;
} = {
  payee: () => ({ field: "payee", op: "contains", value: "" }),
  note: () => ({ field: "note", op: "contains", value: "" }),
  tags: () => ({ field: "tags", op: "contains", value: "" }),
  amount: () => ({ field: "amount", op: "gt", value: 0 }),
  account: (accountId: number) => ({ field: "account", op: "is", accountId }),
  currency: () => ({ field: "currency", op: "is", value: "CAD" }),
  date: () => ({ field: "date", op: "weekday", weekday: 1 }),
  ticker: () => ({ field: "ticker", op: "contains", value: "" }),
  security_name: () => ({ field: "security_name", op: "contains", value: "" }),
  quantity: () => ({ field: "quantity", op: "gt", value: 0 }),
  merchant_category_code: () => ({ field: "merchant_category_code", op: "is", value: "" }),
};

/** Build a fully-typed default `Condition` when the editor switches `field`. */
export function defaultConditionForField(
  field: ConditionField,
  accountId = 0,
): Condition {
  return field === "account"
    ? CONDITION_DEFAULTS.account(accountId)
    : CONDITION_DEFAULTS[field]();
}

/**
 * Default `Action` for a freshly-selected kind. Each entry returns the exact
 * discriminated-union member, so a typo in the config object fails to compile.
 */
export const ACTION_DEFAULTS: {
  [K in ActionKind]: (id: number) => Extract<Action, { kind: K }>;
} = {
  set_category: (categoryId) => ({ kind: "set_category", categoryId }),
  set_tags: () => ({ kind: "set_tags", tags: "" }),
  rename_payee: () => ({ kind: "rename_payee", to: "" }),
  set_account: (accountId) => ({ kind: "set_account", accountId }),
  set_entered_currency: () => ({ kind: "set_entered_currency", currency: "USD" }),
  set_portfolio_holding: (holdingId) => ({ kind: "set_portfolio_holding", holdingId }),
  create_transfer: (destAccountId) => ({ kind: "create_transfer", destAccountId }),
  // Default to a Buy that pulls qty + total straight off the captured row and
  // resolves the position from the row's ticker. `investmentAccountId` is the
  // seeded placeholder (0 until the user picks one).
  record_investment_op: (investmentAccountId) => ({
    kind: "record_investment_op",
    op: "buy",
    investmentAccountId,
    useRowTicker: true,
    qty: { from: "row_quantity" },
    total: { from: "row_amount" },
  }),
};

/** Build a fully-typed default `Action` when the editor switches `kind`. */
export function defaultActionForKind(kind: ActionKind, id = 0): Action {
  return ACTION_DEFAULTS[kind](id);
}

/**
 * Helper — extract every FK id referenced by an action array, so callers
 * can drive `verifyOwnership` in one batch instead of N+1 queries.
 *
 * Used by REST POST/PUT /api/rules and the staged-import inline create-rule
 * endpoint. Returns deduped arrays per FK kind.
 */
export function collectActionFKs(actions: Action[]): {
  categoryIds: number[];
  accountIds: number[];
  holdingIds: number[];
} {
  const categoryIds = new Set<number>();
  const accountIds = new Set<number>();
  const holdingIds = new Set<number>();
  for (const a of actions) {
    switch (a.kind) {
      case "set_category":
        categoryIds.add(a.categoryId);
        break;
      case "set_account":
        accountIds.add(a.accountId);
        break;
      case "set_portfolio_holding":
        holdingIds.add(a.holdingId);
        break;
      case "create_transfer":
        accountIds.add(a.destAccountId);
        break;
      case "record_investment_op":
        accountIds.add(a.investmentAccountId);
        if (a.counterpartyAccountId != null) accountIds.add(a.counterpartyAccountId);
        if (a.holdingId != null) holdingIds.add(a.holdingId);
        if (a.categoryId != null) categoryIds.add(a.categoryId);
        break;
      default:
        break;
    }
  }
  return {
    categoryIds: [...categoryIds],
    accountIds: [...accountIds],
    holdingIds: [...holdingIds],
  };
}

/**
 * Action kinds that mutate ROWS OTHER THAN the matched transaction (or create
 * new rows). These must NOT be applied by paths that only have a single
 * committed row in scope (e.g. `apply_rules_to_uncategorized`) — silent
 * balance corruption risk otherwise. Approve-time paths can run them.
 */
export const SIDE_EFFECT_ACTION_KINDS = new Set([
  "set_account",
  "create_transfer",
  // record_investment_op writes a multi-row lot-aware portfolio op (and may
  // create a position / cash sleeve) — strictly more side-effecting than a
  // transfer. Only the bank-row materialize path may run it.
  "record_investment_op",
]);

export function actionHasSideEffects(action: Action): boolean {
  return SIDE_EFFECT_ACTION_KINDS.has(action.kind);
}

export function ruleHasSideEffects(actions: Action[]): boolean {
  return actions.some(actionHasSideEffects);
}

// ─── Investment-op action semantic validation (FINLYNQ-208) ──────────────────
//
// The Zod schema keeps `record_investment_op` permissive (optional fields) so
// the editor can hold a half-filled action. This validates the FILLED action at
// the write path (POST/PUT /api/rules) and is re-asserted inside the executor.
// Pure — no DB I/O; FK ownership is checked separately via collectActionFKs.

/** Ops that move shares and therefore need a position + a qty/total binding. */
const TRADE_OPS = new Set<InvestmentOp>(["buy", "sell"]);
/** Ops that attribute cash to a security (related holding optional). */
const HOLDING_CASH_OPS = new Set<InvestmentOp>(["dividend", "interest", "fee"]);

export type InvestmentOpValidationError =
  | "missing_account"
  | "missing_position"
  | "missing_counterparty"
  | "self_counterparty"
  | "missing_qty_binding"
  | "missing_total_binding"
  | "insufficient_trade_bindings"
  | "shares_unsupported_op"
  | "fixed_value_nonpositive";

function isPositiveFixed(src: VarSource | undefined): boolean | null {
  // Returns true/false when the source is a fixed value (whether it's > 0),
  // null when the source is a row binding (validated at execution against the
  // actual row). Used so an obviously-bad fixed value fails at author time.
  if (!src) return null;
  if (src.from === "fixed") return src.value > 0;
  return null;
}

/**
 * Validate a filled `record_investment_op` action. Returns null when valid, or
 * a typed error code. Does NOT check FK ownership (that's collectActionFKs +
 * verifyOwnership at the route).
 */
export function validateInvestmentOpAction(
  a: RecordInvestmentOpAction,
): InvestmentOpValidationError | null {
  if (!a.investmentAccountId || a.investmentAccountId <= 0) return "missing_account";

  // Income-as-shares (DRIP) is only valid for dividend / interest income.
  if (a.settleAs === "shares" && a.op !== "dividend" && a.op !== "interest") {
    return "shares_unsupported_op";
  }

  if (a.op === "deposit" || a.op === "withdrawal") {
    if (!a.counterpartyAccountId || a.counterpartyAccountId <= 0) return "missing_counterparty";
    if (a.counterpartyAccountId === a.investmentAccountId) return "self_counterparty";
    if (isPositiveFixed(a.total) === false) return "fixed_value_nonpositive";
    return null;
  }

  if (TRADE_OPS.has(a.op)) {
    if (!a.holdingId && !a.useRowTicker) return "missing_position";
    // Need at least two of {qty, total, price} to derive the trade.
    const present = [a.qty, a.total, a.price].filter((s) => s != null).length;
    if (present < 2) return "insufficient_trade_bindings";
    if (isPositiveFixed(a.qty) === false) return "fixed_value_nonpositive";
    if (isPositiveFixed(a.total) === false) return "fixed_value_nonpositive";
    if (isPositiveFixed(a.price) === false) return "fixed_value_nonpositive";
    return null;
  }

  if (HOLDING_CASH_OPS.has(a.op)) {
    if (a.settleAs === "shares") {
      // DRIP: the income lands as SHARES on a REQUIRED position, derived from
      // qty + total (any two of {qty,total,price}, like a trade).
      if (!a.holdingId && !a.useRowTicker) return "missing_position";
      const present = [a.qty, a.total, a.price].filter((s) => s != null).length;
      if (present < 2) return "insufficient_trade_bindings";
      if (isPositiveFixed(a.qty) === false) return "fixed_value_nonpositive";
      if (isPositiveFixed(a.total) === false) return "fixed_value_nonpositive";
      if (isPositiveFixed(a.price) === false) return "fixed_value_nonpositive";
      return null;
    }
    // Cash settle (legacy): dividend / interest can attribute to a holding
    // (optional); fee likewise.
    if (!a.total) return "missing_total_binding";
    if (isPositiveFixed(a.total) === false) return "fixed_value_nonpositive";
    return null;
  }

  return null;
}
