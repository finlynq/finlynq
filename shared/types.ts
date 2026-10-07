// Shared types between web and mobile apps
// These types mirror the database schema and API response shapes

// --- API Response Envelope ---
export type ApiSuccessResponse<T> = {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
};

export type ApiErrorResponse = {
  success: false;
  error: string;
  /** Machine-readable reason when the server sends one (e.g.
   *  `fx-currency-needs-override`); `error` stays the human message. */
  code?: string;
};

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// --- Domain Entities ---

export interface Account {
  id: number;
  type: "A" | "L"; // Asset or Liability
  group: string;
  name: string;
  currency: string;
  note: string;
}

export interface Category {
  id: number;
  type: "E" | "I" | "R"; // Expense, Income, Reconciliation
  group: string;
  name: string;
  note: string;
}

export interface Transaction {
  id: number;
  date: string;
  accountId: number | null;
  categoryId: number | null;
  currency: string;
  amount: number;
  quantity: number | null;
  portfolioHolding: string | null;
  note: string;
  payee: string;
  tags: string;
  isBusiness: number;
  splitPerson: string | null;
  splitRatio: number | null;
  importHash: string | null;
  fitId: string | null;
  /** Decrypted category name — GET /api/transactions resolves this per row
   *  (route.ts decrypts categoryNameCt and strips the ciphertext companion). */
  categoryName?: string | null;
  /** True when the transaction carries split rows. NOTE: the REST list route
   *  does NOT currently populate this — mobile fetches splits per-tx on the
   *  detail screen. Kept optional for forward-compat with a future list field. */
  hasSplits?: boolean;
}

/**
 * A transaction split — view metadata that divides one already-saved parent
 * transaction across multiple category/account rows. Splits do NOT change the
 * parent's amount/category/account; saving them only bumps the parent's
 * updated_at. The read shape returned by GET /api/transactions/splits (the
 * server decrypts note/tags with the user DEK). `amount` is the
 * account-currency value and carries the same sign as the parent.
 */
export interface Split {
  id: number;
  transactionId: number;
  categoryId: number | null;
  accountId: number | null;
  amount: number;
  note?: string | null;
  tags?: string | null;
}

/**
 * Per-split element of the POST /api/transactions/splits body. `transactionId`
 * rides at the top level of the request and the server derives id + the
 * entered_* currency trilogy from the parent — so the write shape drops both.
 * Send note/tags as plaintext strings (or omit); the server owns encryption.
 */
export type SplitInput = Omit<Split, "id" | "transactionId">;

export interface Budget {
  id: number;
  categoryId: number;
  month: string;
  amount: number;
  currency: string;
}

export interface Goal {
  id: number;
  name: string;
  type: "savings" | "debt_payoff" | "investment" | "emergency_fund";
  targetAmount: number;
  deadline: string | null;
  accountId: number | null;
  currency?: string | null;
  priority: number;
  status: string;
  note: string;
}

/** GET /api/goals shape — base Goal plus the server-computed progress fields. */
export interface GoalWithProgress extends Goal {
  currentAmount: number;
  /** 0–100 percentage toward the target. */
  progress: number;
  /** Alias of `progress` (mirrors the MCP get_goals output). */
  percentComplete: number;
  remaining: number;
  monthlyNeeded: number;
  /** Issue #130 — every linked account id (the edit-prefill reads this back
   *  into the multi-select). `accounts` is the parallel decrypted-name list. */
  accountIds?: number[];
  accounts?: string[];
}

export interface Loan {
  id: number;
  name: string;
  type: "mortgage" | "lease" | "loan" | "student_loan" | "credit_card";
  accountId: number | null;
  principal: number;
  annualRate: number;
  termMonths: number;
  startDate: string;
  paymentAmount: number | null;
  paymentFrequency: string;
  extraPayment: number;
  note: string;
}

export interface PortfolioHolding {
  id: number;
  accountId: number | null;
  name: string;
  symbol: string | null;
  currency: string;
  isCrypto: number;
  note: string;
}

/** Billing cadence. GET /api/subscriptions always serves one of these
 *  (legacy "yearly" is normalized to "annual" server-side). */
export type SubscriptionFrequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "semiannual"
  | "annual";

export interface Subscription {
  id: number;
  /** DEK-decrypted; null under a cold DEK. */
  name: string | null;
  amount: number;
  currency: string;
  frequency: SubscriptionFrequency;
  categoryId: number | null;
  categoryName?: string | null;
  accountId: number | null;
  accountName?: string | null;
  nextDate: string | null;
  status: "active" | "paused" | "cancelled";
  cancelReminderDate: string | null;
  notes: string | null;
  /** Additive, server-computed at the CURRENT rate (FINLYNQ-123) — totals only. */
  displayCurrency?: string;
  displayAmount?: number;
}

/** POST /api/subscriptions body. Omit (don't null) empty optionals on create. */
export interface SubscriptionFormData {
  name: string;
  amount: number;
  currency?: string;
  frequency: SubscriptionFrequency;
  categoryId?: number | null;
  accountId?: number | null;
  nextDate?: string | null;
  status?: "active" | "paused" | "cancelled";
  cancelReminderDate?: string | null;
  notes?: string | null;
}

/** GET /api/recurring — repeating series detected in the user's transactions. */
export interface RecurringItem {
  payee: string;
  /** Signed: negative = bill, positive = income. Native currency. */
  avgAmount: number;
  currency: string;
  avgAmountDisplay?: number;
  /** Detector vocabulary — may be "yearly"; normalize before use. */
  frequency: string;
  count: number;
  lastDate: string;
  nextDate: string;
  accountId: number;
  categoryId: number | null;
}

export interface RecurringResponse {
  recurring: RecurringItem[];
  displayCurrency?: string;
  monthlyRecurringTotal?: number;
  count?: number;
}

export interface Snapshot {
  id: number;
  accountId: number | null;
  date: string;
  value: number;
  note: string;
}

export interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  read: number;
  createdAt: string;
  metadata: string;
}

// --- Announcements (admin broadcast) ---
/** GET /api/announcements row — admin-authored broadcast item + per-user read flag. */
export interface Announcement {
  id: number;
  title: string;
  body: string;
  category: string; // 'news' | 'update' | 'maintenance'
  severity: "info" | "warning";
  pinned: boolean;
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** Whether the requesting user has read/dismissed this item. */
  read: boolean;
}

// --- Feedback ---
export type FeedbackType = "bug" | "idea" | "question" | "other";
/** POST /api/feedback body. */
export interface FeedbackFormData {
  type: FeedbackType;
  message: string;
  pageUrl?: string;
  appVersion?: string;
}

// --- Auth ---
/** Shape returned by GET /api/auth/session — the backend identity source. */
export interface SessionInfo {
  authenticated: boolean;
  method: string | null;
  authMethod?: string | null;
  userId: string | null;
  mfaVerified?: boolean;
  /** FINLYNQ-152 follow-up — authenticated but the server has no DEK for this
   *  session (it restarted since login). Encrypted fields can't be decrypted
   *  (reads show ciphertext, writes 423 session_locked); the mobile app
   *  re-authenticates on open/resume/unlock when this is true. */
  encryptionLocked?: boolean;
  onboardingComplete?: boolean;
  isAdmin?: boolean;
  username?: string | null;
  email?: string | null;
  displayName?: string | null;
  displayCurrency?: string;
}

/** Payload for POST /api/auth/register. Username is the required identifier;
 *  email is an optional recovery channel. When email is omitted the user must
 *  set acknowledgeNoRecovery=true (no password-recovery path). */
export interface RegisterPayload {
  username: string;
  email?: string;
  password: string;
  displayName?: string;
  acknowledgeNoRecovery?: boolean;
}

// --- Dashboard ---
export interface DashboardData {
  /**
   * The user's display (reporting) currency, from the top-level
   * `displayCurrency` of GET /api/dashboard. EVERY aggregate on this object
   * (net worth, assets, liabilities, monthly income/expenses) is denominated in
   * it. Falls back to USD (never CAD) when the server omits it.
   */
  displayCurrency: string;
  netWorth: number;
  totalAssets: number;
  totalLiabilities: number;
  /**
   * "YYYY-MM" of the month `monthlyIncome`/`monthlyExpenses`/`savingsRate`
   * summarize — the last COMPLETE month when the newest tracked month is the
   * current (partial) calendar month (mirrors web FINLYNQ-291 C1). `null` when
   * no month has any income/expense rows yet.
   */
  referenceMonth: string | null;
  monthlyIncome: number;
  monthlyExpenses: number;
  /** Savings rate of `referenceMonth` in percent; may be negative. */
  savingsRate: number;
  recentTransactions: Transaction[];
  accountBalances: Array<{ name: string; balance: number; type: string; currency: string }>;
}

// --- Health Score ---
export interface HealthScoreComponent {
  name: string;
  score: number;
  weight: number;
  weighted: number;
  detail: string;
}

export interface HealthScoreData {
  score: number;
  grade: "Excellent" | "Good" | "Fair" | "Needs Work";
  components: HealthScoreComponent[];
  /**
   * 3-month (income − expenses) / income in percent (FINLYNQ-291). May be
   * NEGATIVE (spent more than earned); `null` when there is no income to divide
   * by. Optional so an older server that omits it degrades gracefully.
   */
  savingsRatePct?: number | null;
}

// --- Budget with spending ---
export interface BudgetWithSpending extends Budget {
  /** Decrypted server-side (`safeName` → "Category #<id>" under a cold DEK). */
  categoryName?: string;
  categoryGroup?: string;
  /** `amount` converted from the row's native `currency` into `displayCurrency`. */
  convertedAmount?: number;
  /** Month's spending in the category, in `displayCurrency`. */
  convertedSpent?: number;
  rolloverAmount?: number;
  /** The currency `convertedAmount`/`convertedSpent` are expressed in. */
  displayCurrency?: string;
}

// --- Per-account balance (the `balances` rows from GET /api/dashboard) ---
// /api/accounts returns accounts WITHOUT balances; the computed + currency-
// converted per-account balance lives in the dashboard payload.
export interface AccountBalance {
  accountId: number;
  accountName: string | null;
  accountType: "A" | "L";
  accountGroup: string;
  currency: string;
  balance: number;
  convertedBalance: number;
  displayCurrency: string;
  isInvestment?: boolean;
  holdingsValue?: number;
  /**
   * Archived accounts ARE included in the dashboard balances (they still count
   * toward net worth). `archived` is a list/picker visibility flag only: list
   * screens hide these rows behind a "Show archived" toggle and create-mode
   * pickers filter them out, but totals must keep them.
   */
  archived?: boolean;
  /** Decrypted alias (null under a cold DEK) — render via safeAccountName. */
  alias?: string | null;
}

// --- Portfolio overview (GET /api/portfolio/overview) ---
/** One consolidated position across accounts (the `byHolding` rollup row). */
export interface PortfolioHoldingSummary {
  key: string;
  symbol: string | null;
  name: string;
  /**
   * FINLYNQ-242 (mobile catch-up to web FINLYNQ-174/194): human-readable
   * long name (Yahoo `meta.shortName`) for the consolidated row, rolled up
   * from the first member whose `quoteName !== symbol`. `null`/absent when no
   * distinct description exists (cash sleeves, metals, custom holdings, or a
   * warm price_cache hit where the quote name mirrors the symbol). The mobile
   * Portfolio row renders this as the primary line + the ticker as subtitle.
   */
  description?: string | null;
  assetType: string | null;
  totalQty: number;
  avgCostDisplay: number | null;
  costBasisDisplay: number;
  marketValueDisplay: number;
  unrealizedGainDisplay: number;
  unrealizedGainPct: number | null;
  realizedGainDisplay: number;
  dividendsDisplay: number;
  totalReturnDisplay: number;
  totalReturnPct: number | null;
  pctOfPortfolio: number | null;
  accountCount: number;
  image?: string | null;
}

export interface PortfolioSummary {
  totalHoldings: number;
  totalAccounts: number;
  totalValueDisplay: number;
  dayChangeDisplay: number;
  dayChangePct: number;
  hasQuantityData: boolean;
  totalCostBasisDisplay: number;
  totalUnrealizedGainDisplay: number;
  totalUnrealizedGainPct: number;
  totalRealizedGainDisplay: number;
  totalDividendsDisplay: number;
  totalReturnDisplay: number;
  totalReturnPct: number;
}

/** Display asset type the overview route derives per position. */
export type PortfolioAssetType = "etf" | "stock" | "crypto" | "cash" | "metal";

/**
 * One consolidated Top Movers row (FINLYNQ-190, pf-app
 * src/lib/portfolio/top-movers.ts). One row per canonical security key, NOT
 * per account. `dayChangeDisplay` is in the overview's `displayCurrency`;
 * `changePct` is a value-weighted aggregate and may be null.
 */
export interface Mover {
  key: string;
  symbol: string | null;
  name: string;
  image: string | null;
  dayChangeDisplay: number;
  changePct: number | null;
}

/** One enriched per-account holding row (overview.holdings). */
export interface EnrichedHolding {
  id: number;
  accountId: number | null;
  accountName: string;
  name: string | null;
  /**
   * FINLYNQ-242: Yahoo `meta.shortName` for this position's symbol, set ONLY
   * when it differs from the symbol (null on a warm price_cache hit, cash,
   * metals, or custom holdings). Source for the `byHolding.description` rollup
   * and the Top-movers / Holding-detail description line.
   */
  quoteName?: string | null;
  /**
   * FINLYNQ-242 (re-graduated): the DURABLE human name from the joined
   * `securities.name_ct` (e.g. "Apple Inc."), present only when the position
   * is backfilled (`security_id` set) and the name is distinct from the
   * ticker. Unlike `quoteName` this survives a warm `price_cache` hit, so it
   * is the PREFERRED source for `byHolding.description`. Null for un-backfilled
   * rows / cash / metals / custom holdings — those fall back to `quoteName`.
   */
  securityName?: string | null;
  symbol: string | null;
  currency: string;
  /** Server derives "metal" for XAU/XAG/XPT/XPD positions (overview route). */
  assetType: PortfolioAssetType;
  price: number | null;
  change: number | null;
  changePct: number | null;
  /** Display-currency day change $ for this position (null = no live quote). */
  dayChangeDisplay?: number | null;
  quoteCurrency: string | null;
  marketCap: number | null;
  image: string | null;
  quantity: number | null;
  avgCostPerShare: number | null;
  totalCostBasis: number | null;
  lifetimeCostBasis: number | null;
  marketValue: number | null;
  marketValueDisplay: number | null;
  unrealizedGain: number | null;
  unrealizedGainPct: number | null;
  unrealizedGainDisplay: number | null;
  realizedGain: number | null;
  dividendsReceived: number | null;
  totalReturn: number | null;
  totalReturnDisplay: number | null;
  totalReturnPct: number | null;
  firstPurchaseDate: string | null;
  daysHeld: number | null;
  pctOfPortfolio: number | null;
}

/** byType / byAccount bucket from the overview payload. */
export interface AllocationBucket {
  count: number;
  value: number;
}

export interface PortfolioOverview {
  holdings: EnrichedHolding[];
  byHolding: PortfolioHoldingSummary[];
  displayCurrency: string;
  summary: PortfolioSummary;
  /** Asset-type breakdown keyed by etf|stock|crypto|cash|metal. */
  byType: Record<string, AllocationBucket>;
  /** Per-account breakdown keyed by (decrypted) account name. */
  byAccount: Record<string, AllocationBucket>;
  topGainers: Mover[];
  topLosers: Mover[];
}

/** GET /api/portfolio bare-array row (decrypted names; powers op-form pickers). */
export interface PortfolioHoldingRow {
  id: number;
  accountId: number | null;
  name: string | null;
  symbol: string | null;
  currency: string;
  isCrypto: number;
  isCash: boolean;
  note: string;
  /** Live SUM(transactions.quantity) for the holding. */
  currentShares: number;
  accountName: string | null;
}

// --- Portfolio performance (GET /api/portfolio/performance, enveloped) ---
export interface PerformancePoint {
  date: string;
  marketValue: number;
  costBasis: number;
  contribution: number;
  gapsFilled: boolean;
}

export interface PortfolioPerformance {
  period: string;
  accountId: number | null;
  from: string;
  to: string;
  currency: string;
  series: PerformancePoint[];
  twrr: { period: number; annualized: number; hadContributions: boolean };
  mwrr: { irr: number; converged: boolean };
  gapsFilledDays: number;
}

// --- Realized gains (GET /api/portfolio/realized-gains, enveloped) ---
export interface RealizedGainRow {
  closureId: number;
  closeDate: string;
  closeTxId: number;
  lotId: number;
  holdingId: number;
  holdingName: string | null;
  accountId: number;
  accountName: string | null;
  qtyClosed: number;
  proceedsPerShare: number;
  costPerShare: number;
  realizedGain: number;
  currency: string;
  openDate: string;
  daysHeld: number;
  term: "short" | "long";
  closeKind: string;
  source: string;
  /** Present only in the unified view (?unified=1): gain in the display currency. */
  realizedGainInBase?: number;
  /** Present only in the unified view: the display currency realizedGainInBase is in. */
  baseCurrency?: string;
  /** True when a historical FX snapshot was missing and a current rate was used. */
  fxSnapshotMissing?: boolean;
}

export interface RealizedGainsResult {
  rows: RealizedGainRow[];
  totals: {
    realizedGain: number;
    qtyClosed: number;
    rowCount: number;
    byCurrency: Record<string, { realizedGain: number; qtyClosed: number }>;
  };
  filter: Record<string, unknown>;
  /** Present only in the unified view (?unified=1). */
  totalRealizedGainInBase?: number;
}

// --- Dividend income (GET /api/portfolio/dividends, enveloped) ---
export interface DividendRow {
  txId: number;
  date: string;
  amount: number;
  currency: string;
  isReinvested: boolean;
  isWithholding: boolean;
  holdingId: number | null;
  holdingName: string | null;
  accountId: number | null;
  accountName: string | null;
  payee: string | null;
}

export interface DividendGroupRow {
  bucket: string;
  label: string;
  amount: number;
  currency: string;
  rowCount: number;
  reinvestedCount: number;
  withholdingCount: number;
  /** Reporting mode only: rows in this bucket not yet re-rated (excluded from amount). */
  unratedCount?: number;
}

export interface DividendIncomeResult {
  rows?: DividendRow[];
  groups?: DividendGroupRow[];
  totals: {
    amount: number;
    rowCount: number;
    byCurrency: Record<string, number>;
    /** Reporting mode only: rows lacking stored reporting fields (excluded from totals). */
    unratedCount?: number;
  };
  /** FINLYNQ-182: "reporting" when ?reportingCurrency=1 was honoured. */
  mode?: "native" | "reporting";
  /** Reporting mode only: the currency totals + group amounts are expressed in. */
  reportingCurrency?: string;
  filter: Record<string, unknown>;
}

// --- Lots (GET /api/portfolio/lots, enveloped { lots }) ---
export interface LotRow {
  lotId: number;
  holdingId: number;
  accountId: number;
  openTxId: number;
  openDate: string;
  qtyOriginal: number;
  qtyRemaining: number;
  /** Alias of qtyRemaining (server provides both). */
  qty: number;
  costPerShare: number;
  costBasis: number;
  currency: string;
  origin: string;
  status: string;
  parentLotId: number | null;
}

// --- Portfolio operations ---
export type PortfolioOpKey =
  | "buy"
  | "sell"
  | "swap"
  | "transfer"
  | "income-expense"
  | "fx-conversion"
  | "deposit"
  | "withdrawal";

/** POST /api/portfolio create-holding body (names sent plaintext; server encrypts). */
export interface HoldingFormData {
  name: string;
  accountId: number;
  symbol?: string;
  currency?: string;
  isCrypto?: boolean;
  note?: string;
}

/** POST /api/portfolio/holdings/cash-sleeve body. */
export interface CashSleevePayload {
  accountId: number;
  currency: string;
  name?: string;
}

/** Structured 4xx body shared by /operations/* + cash-sleeve. The mobile
 *  postPortfolioOperation helper preserves these fields (the generic
 *  request() helper would collapse them to a plain string). */
export interface OpErrorInfo {
  error: string;
  code?: string;
  currency?: string;
  accountId?: number;
  holdingId?: number;
  expected?: string;
  got?: string;
  blockingClosureTxIds?: number[];
}

/** Result envelope from postPortfolioOperation — structured-error aware. */
export interface OpResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: OpErrorInfo;
}

export interface LotSelection {
  method: "FIFO" | "HIFO" | "SPECIFIC";
  lotIds?: number[];
  lots?: Array<{ lotId: number; qty: number }>;
}

export interface BuyOpBody {
  accountId: number;
  holdingId: number;
  qty: number;
  totalCost: number;
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  cashSleeveHoldingId?: number;
  editId?: number;
}

export interface SellOpBody {
  accountId: number;
  holdingId: number;
  qty: number;
  totalProceeds: number;
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  cashSleeveHoldingId?: number;
  lotSelection?: LotSelection;
  editId?: number;
}

export interface SwapOpBody {
  accountId: number;
  sourceHoldingId: number;
  sourceQty: number;
  sourceProceeds: number;
  destHoldingId: number;
  destQty: number;
  destCost: number;
  date: string;
  payee?: string;
  note?: string;
  editId?: number;
}

export interface TransferOpBody {
  sourceAccountId: number;
  destAccountId: number;
  holdingId: number;
  qty: number;
  date: string;
  payee?: string;
  note?: string;
  editId?: number;
}

export interface IncomeExpenseOpBody {
  accountId: number;
  currency: string;
  amount: number;
  relatedHoldingId?: number | null;
  categoryId?: number | null;
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  editId?: number;
}

export interface FxConversionOpBody {
  accountId: number;
  fromCurrency: string;
  fromAmount: number;
  toCurrency: string;
  toAmount: number;
  feeAmount?: number;
  feeCurrency?: string;
  feeOnSleeveCurrency?: string;
  date: string;
  payee?: string;
  note?: string;
  editId?: number;
}

export interface DepositOpBody {
  sourceAccountId: number;
  destAccountId: number;
  destCashSleeveHoldingId?: number;
  amount: number;
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  editId?: number;
}

export interface WithdrawalOpBody {
  sourceAccountId: number;
  sourceCashSleeveHoldingId?: number;
  destAccountId: number;
  amount: number;
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  editId?: number;
}

export type PortfolioOpBody =
  | BuyOpBody
  | SellOpBody
  | SwapOpBody
  | TransferOpBody
  | IncomeExpenseOpBody
  | FxConversionOpBody
  | DepositOpBody
  | WithdrawalOpBody;

/** GET /api/portfolio/operations/load?id=N response data (loose superset —
 *  shape varies by op kind; the registry's prefillFromLoad guards on `op`). */
export interface OperationLoadData {
  op: PortfolioOpKey;
  primaryTxId: number;
  accountId?: number | null;
  holdingId?: number | null;
  qty?: number;
  totalCost?: number;
  totalProceeds?: number;
  sourceAccountId?: number | null;
  destAccountId?: number | null;
  sourceHoldingId?: number | null;
  destHoldingId?: number | null;
  sourceQty?: number;
  sourceProceeds?: number;
  destQty?: number;
  destCost?: number;
  destCashSleeveHoldingId?: number | null;
  sourceCashSleeveHoldingId?: number | null;
  amount?: number;
  currency?: string;
  fromCurrency?: string;
  fromAmount?: number;
  toCurrency?: string;
  toAmount?: number;
  feeAmount?: number | null;
  feeCurrency?: string | null;
  feeOnSleeveCurrency?: string | null;
  relatedHoldingId?: number | null;
  categoryId?: number | null;
  date?: string;
  payee?: string;
  note?: string;
  tags?: string;
}

/** POST /api/transactions/transfer body — same-currency transfers only on mobile. */
export interface TransferPayload {
  fromAccountId: number;
  toAccountId: number;
  /** What left the From account, in the From account's currency. */
  enteredAmount: number;
  /** Cross-currency only: what arrived in the To account, in ITS currency.
   *  Omitted → the server converts at the market rate for the date (409
   *  `fx-currency-needs-override` when it has none). */
  receivedAmount?: number;
  date?: string;
  note?: string;
  tags?: string;
}

/** GET /api/fx/preview — plain JSON (not enveloped). `converted` is `amount`
 *  in `to` at `rate`; `needsOverride` = no market rate for the pair/date. */
export interface FxPreview {
  from: string;
  to: string;
  date: string;
  rate: number;
  source: string;
  amount: number | null;
  converted: number | null;
  needsOverride?: boolean;
}

// --- Create-flow form payloads (mobile) ---
/** POST /api/accounts body. Names are sent plaintext; the server encrypts via
 *  buildNameFields. Opening balance is deferred (set it via a transaction). */
export interface AccountFormData {
  name: string;
  type: "A" | "L";
  group: string;
  currency: string;
  alias?: string;
  note?: string;
  isInvestment?: boolean;
}

/** POST /api/categories body. */
export interface CategoryFormData {
  name: string;
  type: "E" | "I" | "R";
  group: string;
  note?: string;
}

/** POST /api/goals body. `accountIds: []` creates a standalone goal. */
export interface GoalFormData {
  name: string;
  type: string;
  targetAmount: number;
  currency?: string;
  deadline?: string;
  accountIds?: number[];
  priority?: number;
  status?: string;
  note?: string;
}

// --- Edit-flow payloads (mobile, P4 settings expansion) ---
// All three entity edits go through the COLLECTION route, NOT a `/[id]`
// sub-route: PUT /api/goals|accounts|categories with `id` in the body. The
// account edit additionally accepts `archived` for the archive affordance.
export type GoalEditData = { id: number } & Partial<GoalFormData>;
export type CategoryEditData = { id: number } & Partial<CategoryFormData>;
export type AccountEditData = { id: number } & Partial<AccountFormData> & {
  archived?: boolean;
};

// --- Transaction form ---
export interface TransactionFormData {
  date: string;
  amount: number;
  accountId: number;
  categoryId: number;
  currency?: string;
  payee?: string;
  note?: string;
  tags?: string;
  isBusiness?: number;
  splitPerson?: string;
  splitRatio?: number;
  quantity?: number;
  portfolioHolding?: string;
}

// --- Reports ---
// Mirror the bare-JSON shapes returned by GET /api/reports (income-statement +
// balance-sheet), /api/reports/trends and /api/reports/yoy. Category/account
// names are decrypted server-side and can be "" under a cold DEK — route every
// label through safeName(). Every report route converts amounts to the user's
// display currency server-side and echoes it as `displayCurrency` (trends + yoy
// prefer each row's stored historical reporting_amount, else convert at the
// current rate). The balance sheet ignores endDate: it is always TODAY's
// balances, whatever range the caller passes.

export type ReportPeriod = "daily" | "weekly" | "monthly" | "quarterly";
export type ReportGroupBy = "category" | "group";

export interface IncomeStatementRow {
  categoryId: number | null;
  categoryType: string;
  categoryGroup: string;
  categoryName: string;
  total: number;
  count: number;
}

export interface UnrealizedReportTotals {
  costBasis: number;
  marketValue: number;
  valuationGL: number;
  fxGL: number;
  totalGL: number;
}

export interface UnrealizedReportAccount {
  accountId: number;
  accountName: string;
  accountCurrency: string;
  costBasis: number;
  marketValue: number;
  valuationGL: number;
  fxGL: number;
  totalGL: number;
  startMarketValue: number;
  endMarketValue: number;
  hasHoldings: boolean;
  costBasisMissing: boolean;
}

export interface IncomeStatement {
  type: "income-statement";
  displayCurrency: string;
  period: { startDate: string; endDate: string };
  income: IncomeStatementRow[];
  expenses: IncomeStatementRow[];
  totalIncome: number;
  totalExpenses: number;
  netSavings: number;
  savingsRate: number;
  unrealized: {
    totals: UnrealizedReportTotals;
    accounts: UnrealizedReportAccount[];
  };
}

export interface BalanceSheetRow {
  accountId: number;
  accountType: string;
  accountGroup: string;
  accountName: string;
  currency: string;
  balance: number;
  convertedBalance: number;
  displayCurrency: string;
}

export interface BalanceSheet {
  type: "balance-sheet";
  displayCurrency: string;
  date: string;
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}

export interface TrendsPoint {
  period: string;
  label: string;
  income: number;
  expenses: number;
  net: number;
}

export interface TrendsBreakdownItem {
  name: string;
  group: string;
  /** Set in groupBy=category mode (FINLYNQ-130); null in group mode, where a
   *  row aggregates many categories. Optional for older servers. */
  categoryId?: number | null;
  total: number;
  count: number;
  periods: Record<string, number>;
}

export interface ReportTrends {
  period: ReportPeriod;
  groupBy: ReportGroupBy;
  startDate: string;
  endDate: string;
  /** Currency every amount below is expressed in (optional for older servers). */
  displayCurrency?: string;
  timeseries: TrendsPoint[];
  income: TrendsBreakdownItem[];
  expenses: TrendsBreakdownItem[];
  totalIncome: number;
  totalExpenses: number;
  netSavings: number;
  savingsRate: number;
}

export interface YoYCategoryRow {
  name: string;
  year1Amount: number;
  year2Amount: number;
  change: number;
}

export interface YoYMonthlyRow {
  month: string;
  year1Income: number;
  year1Expenses: number;
  year2Income: number;
  year2Expenses: number;
}

export interface YoYReport {
  year1: number;
  year2: number;
  /** Currency every amount below is expressed in (optional for older servers). */
  displayCurrency?: string;
  /** Expense categories; amounts are FULL calendar years on both sides. */
  categories: YoYCategoryRow[];
  monthly: YoYMonthlyRow[];
}

// --- Reconcile inbox (account-anchored card flows; mirrors web /inbox) ---
// The mobile app ports ONLY the phone-native card lenses — Approve-each
// (mode='approve') + Auto-pilot categorize (mode='auto'). The two-pane N×M
// grid + Manual-mode staging review stay web-only. Decrypted name/payee fields
// can be null/"" under a cold DEK — route every label through safeName/
// safeAccountName.

/** Per-account reconciliation policy, persisted on `accounts.mode`. */
export type AccountMode = "auto" | "approve" | "manual";

/**
 * Full decrypted account row from GET /api/accounts — a superset of the base
 * `Account` (which the typed `getAccounts` narrows to) and `InboxAccount`. The
 * mobile account-detail surface needs all of these to drive the edit prefill
 * (type/group/note/alias), the archive flag, and the reconciliation-mode
 * picker. Name/alias can be null under a cold DEK — route through safeName.
 */
export interface AccountDetailRow {
  id: number;
  type: "A" | "L";
  group: string;
  name: string | null;
  alias?: string | null;
  currency: string;
  note?: string | null;
  archived?: boolean;
  isInvestment?: boolean;
  mode: AccountMode;
}

/**
 * The four fuzzy-match thresholds the /reconcile match-engine uses. Persisted
 * via GET/PUT /api/settings/reconcile-thresholds (enveloped {success,data}).
 */
export interface ReconcileThresholds {
  dateToleranceDays: number;
  amountTolerancePct: number;
  amountToleranceFloor: number;
  scoreThreshold: number;
}

/**
 * Account row as returned by GET /api/accounts (bare array). Richer than the
 * base `Account` type — it carries the decrypted name/alias, the archived flag,
 * the investment flag, and the reconciliation `mode` the inbox is keyed on.
 */
export interface InboxAccount {
  id: number;
  name: string | null;
  alias?: string | null;
  currency: string;
  archived?: boolean;
  isInvestment?: boolean;
  mode: AccountMode;
}

/** One already-committed (bank ↔ tx) link from /api/reconcile/suggestions. */
export interface ReconcileLink {
  transactionId: number;
  bankTransactionId: string;
  linkType: "primary" | "extra";
  source: string;
  createdAt: string;
}

/** A not-yet-linked match candidate (exact-hash or fuzzy). */
export interface ReconcileSuggestion {
  transactionId: number;
  bankTransactionId: string;
  strategy: string;
  score: number;
  reason: string;
  daysOff: number;
  amountDeltaAbs: number;
}

/** Per-id transaction enrichment (decrypted) so the UI doesn't re-decrypt. */
export interface ReconcileTxSnapshot {
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  categoryName: string | null;
  categoryType: string | null;
}

/** Per-id bank-row enrichment incl. the rule-engine suggested category. */
export interface ReconcileBankSnapshot {
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  accountId: number;
  suggestedCategoryId: number | null;
  /** Destination account id from a matched transfer-only rule
   *  (`create_transfer`, no `set_category`). Mirrors `suggestedCategoryId`.
   *  The server match engine (`computeReconcileForAccount`) sets it and the
   *  suggestions route serializes it; the mobile inbox surfaces it as a
   *  "transfer to <Account>" card that `/approve` materializes as a transfer
   *  pair. null = no transfer rule matched (web parity, FINLYNQ-126). */
  suggestedTransferAccountId: number | null;
  /** A pre-existing UNLINKED ledger transaction this bank row appears to
   *  duplicate (exact import_hash, or identical amount within the date
   *  tolerance — the strict, per-row signal, NOT the loose `suggestions`
   *  fuzzy layer). null = none. Set by the server match engine on every
   *  bank snapshot. Drives the "Possible duplicate · Link to existing vs
   *  Keep separate" choice on the Approve-each / Auto-pilot cards so the
   *  inbox never silently mints a second ledger entry (web parity,
   *  2026-06-04). */
  duplicateOfTransactionId: number | null;
}

/**
 * GET /api/reconcile/suggestions `data` payload (ENVELOPED — read res.data).
 * `linked` drives the Reconciled tab; bank rows NOT in `linked` are the
 * To-approve / To-categorize cards.
 */
export interface ReconcileSuggestions {
  linked: ReconcileLink[];
  suggestions: ReconcileSuggestion[];
  bankOnly: string[];
  txOnly: number[];
  transactions: Record<number, ReconcileTxSnapshot>;
  bankTransactions: Record<string, ReconcileBankSnapshot>;
}

/** One recent auto-rule-fired tx (the Auto-pilot Reconciled banner). */
export interface AutoRuleItem {
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  categoryName: string | null;
  bankTransactionId: string | null;
  createdAt: string;
}

/** GET /api/reconcile/auto-rule-recent `data` payload (ENVELOPED — res.data). */
export interface AutoRuleRecent {
  count: number;
  windowDays: number;
  items: AutoRuleItem[];
}

/** Body for POST /api/bank-transactions/[bankId]/approve|categorize.
 *  Exactly one of `categoryId` / `transferDestAccountId` is sent (the server
 *  enforces this): `categoryId` commits the row to the ledger under that
 *  category; `transferDestAccountId` (approve-only — `/categorize` cannot write
 *  transfers) materializes a transfer pair to that destination account
 *  (FINLYNQ-126). */
export interface BankRowCommitBody {
  categoryId?: number;
  transferDestAccountId?: number;
  payee?: string;
  accountId?: number;
}

// ─── Category reports (2026-10) ─────────────────────────────────────────────
// GET /api/reports/categories + /api/reports/category. Both routes return the
// apiHandler envelope `{ success, data }`, which request() passes through, so
// `res.data` is the payload below. Amounts are in `displayCurrency`, oriented
// POSITIVE in the category's direction (spend for expenses, receipts for income).

export interface CategoryOverviewRow {
  id: number;
  name: string | null;
  group: string;
  amount: number;
  /** Share of the month's total, 0..1. */
  share: number;
  /** Usual month: average of complete months before `month`, from first activity. */
  average: number | null;
  /** (amount − average) ÷ average. */
  change: number | null;
  budget: number | null;
  /** Window months oldest → newest, selected month last. */
  trend: number[];
}

export interface CategoryOverviewResponse {
  type: "E" | "I";
  displayCurrency: string;
  month: string;
  partial: boolean;
  windowMonths: string[];
  windowMonthsCount: number;
  total: number;
  averageTotal: number | null;
  categories: CategoryOverviewRow[];
}

export interface CategoryDetailMonth {
  month: string;
  amount: number;
  count: number;
  budget: number | null;
  partial: boolean;
}

export interface CategoryDetailResponse {
  category: { id: number; name: string | null; type: "E" | "I" | "R"; group: string };
  windowMonths: number;
  displayCurrency: string;
  payeesLocked: boolean;
  months: CategoryDetailMonth[];
  stats: {
    thisMonth: number;
    lastMonth: number;
    sameMonthLastYear: number;
    averageMonthly: number | null;
    medianMonthly: number | null;
    highestMonth: { month: string; amount: number } | null;
    total: number;
    transactionCount: number;
    averageTransaction: number | null;
    shareOfType: number | null;
  };
  hasBudget: boolean;
  topPayees: { payee: string; amount: number; count: number; share: number }[];
  recent: { id: number; date: string; payee: string | null; amount: number; currency: string; accountName: string | null }[];
}

// ─── Transactions calendar (2026-10) ────────────────────────────────────────
// GET /api/transactions/calendar?month=YYYY-MM[&accountId=][&categoryId=].
// apiHandler envelope `{ success, data }` (request() passes it through, so
// `res.data` is the payload below). Only days WITH transactions appear in
// `days`. Amounts are already in `displayCurrency` and follow the Reports flow
// rules: `income` = income-category rows, `spending` = expense-category rows
// oriented positive (negative when refunds exceed spend); transfers and
// investment trades are in `count` but move neither total.

export interface TransactionsCalendarDay {
  date: string;
  income: number;
  spending: number;
  count: number;
}

export interface TransactionsCalendarResponse {
  month: string;
  displayCurrency: string;
  days: TransactionsCalendarDay[];
  totals: { income: number; spending: number; count: number };
}
