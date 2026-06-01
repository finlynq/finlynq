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
}

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

export interface Subscription {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: "weekly" | "monthly" | "quarterly" | "annual";
  categoryId: number | null;
  accountId: number | null;
  nextDate: string | null;
  status: "active" | "paused" | "cancelled";
  cancelReminderDate: string | null;
  notes: string | null;
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
  netWorth: number;
  totalAssets: number;
  totalLiabilities: number;
  monthlyIncome: number;
  monthlyExpenses: number;
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
}

// --- Budget with spending ---
export interface BudgetWithSpending extends Budget {
  categoryName?: string;
  categoryGroup?: string;
  convertedAmount?: number;
  convertedSpent?: number;
  rolloverAmount?: number;
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
}

// --- Portfolio overview (GET /api/portfolio/overview) ---
/** One consolidated position across accounts (the `byHolding` rollup row). */
export interface PortfolioHoldingSummary {
  key: string;
  symbol: string | null;
  name: string;
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

export interface PortfolioOverview {
  holdings: unknown[];
  byHolding: PortfolioHoldingSummary[];
  displayCurrency: string;
  summary: PortfolioSummary;
}

/** POST /api/transactions/transfer body — same-currency transfers only on mobile. */
export interface TransferPayload {
  fromAccountId: number;
  toAccountId: number;
  enteredAmount: number;
  date?: string;
  note?: string;
  tags?: string;
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
