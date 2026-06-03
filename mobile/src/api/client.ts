// Typed API client for connecting to the Finlynq Next.js backend.
//
// IMPORTANT — envelope mismatch (fixed 2026-05-29): the Finlynq REST API
// returns **bare JSON** (`[...]` or `{...}`), NOT the `{ success, data }`
// envelope. That envelope is an MCP-tool convention only (CLAUDE.md). Every
// mobile screen, however, gates rendering on `res.success`. The result was
// every screen rendering empty (success === undefined → falsy). `request()`
// below normalizes a bare REST payload into the `ApiResponse<T>` shape the
// screens expect, using the HTTP status as the success signal. A route that
// already returns an envelope is passed through unchanged (defensive).
import type { ApiResponse, SessionInfo } from "../../../shared/types";
import { logger, describeShape } from "../lib/logger";

let _serverUrl = "https://finlynq.com";
let _authToken: string | null = null;

export function setServerUrl(url: string) {
  _serverUrl = url.replace(/\/$/, "");
}

export function getServerUrl(): string {
  return _serverUrl;
}

/** Store a JWT token for managed (cloud) mode requests */
export function setAuthToken(token: string | null) {
  _authToken = token;
}

export function getAuthToken(): string | null {
  return _authToken;
}

async function safeParseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function extractError(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string" && e.length > 0) return e;
  }
  return `HTTP ${status}`;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = `${_serverUrl}${path}`;
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  // Attach Bearer token for cloud/managed mode (best-effort; the primary auth
  // path is RN's native cookie jar carrying the httpOnly pf_session cookie).
  if (_authToken) {
    headers["Authorization"] = `Bearer ${_authToken}`;
  }

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { ...options, headers });
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logger.error("api", `${method} ${path} — network error`, { detail });
    return { success: false, error: `Network error: ${detail}` };
  }
  const ms = Date.now() - start;
  const body = await safeParseJson(res);

  if (!res.ok) {
    const error = extractError(body, res.status);
    // 401/403 here means the cookie jar did not carry pf_session — the single
    // most useful signal for the empty-data class of bugs, so log it loudly.
    logger.warn("api", `${method} ${path} → ${res.status} (${ms}ms)`, {
      error,
      authToken: _authToken ? "present" : "absent",
    });
    return { success: false, error };
  }

  // Already enveloped? (no REST route does this today, but be defensive.)
  if (body && typeof body === "object" && "success" in body) {
    logger.debug("api", `${method} ${path} → ${res.status} (${ms}ms, enveloped)`);
    return body as ApiResponse<T>;
  }

  logger.debug("api", `${method} ${path} → ${res.status} (${ms}ms)`, {
    shape: describeShape(body),
  });
  return { success: true, data: body as T };
}

/** Raw fetch for auth endpoints that need to extract tokens from response */
export async function authRequest(
  path: string,
  body: unknown
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; token?: string }> {
  const url = `${_serverUrl}${path}`;
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logger.error("auth", `POST ${path} — network error`, { detail, serverUrl: _serverUrl });
    throw e; // useAuth surfaces this as "Cannot connect"
  }
  const ms = Date.now() - start;
  const data = ((await safeParseJson(res)) as Record<string, unknown> | null) ?? {};

  // Extract session token from Set-Cookie header for mobile storage. RN's fetch
  // usually cannot read the httpOnly Set-Cookie (the native cookie jar consumes
  // it), so this is best-effort. Fall back to a token in the response body if a
  // future backend revision returns one there.
  let token: string | undefined;
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    const match = setCookie.match(/pf_session=([^;]+)/);
    if (match) token = match[1];
  }
  if (!token && typeof data.token === "string") token = data.token as string;

  logger.info("auth", `POST ${path} → ${res.status} (${ms}ms)`, {
    ok: res.ok,
    tokenRecovered: token ? "yes" : "no",
    keys: Object.keys(data),
  });

  return { ok: res.ok, status: res.status, data, token };
}

/**
 * GET /api/auth/session — the single identity source of truth on the backend.
 * Returns a bare `{ authenticated, userId, ... }` shape (NOT the `{ success,
 * data }` envelope), so it bypasses the typed `api.get` helper. The stored
 * session JWT rides along as a Bearer token.
 */
export async function getSession(): Promise<SessionInfo> {
  const url = `${_serverUrl}/api/auth/session`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (_authToken) {
    headers["Authorization"] = `Bearer ${_authToken}`;
  }
  const start = Date.now();
  const res = await fetch(url, { headers });
  const ms = Date.now() - start;
  const data = ((await safeParseJson(res)) as SessionInfo | null) ?? {
    authenticated: false,
    method: null,
    userId: null,
  };
  logger.info("auth", `GET /api/auth/session → ${res.status} (${ms}ms)`, {
    authenticated: data.authenticated,
    method: data.method,
  });
  return data;
}

/**
 * Structured-error-aware POST for /api/portfolio/operations/* + cash-sleeve.
 *
 * Those routes return a BARE `{ id, ... }` on 2xx but a BARE structured error
 * `{ error, code?, currency?, blockingClosureTxIds?, ... }` on 4xx. The generic
 * `request()` helper collapses errors to a plain string (dropping `code` /
 * `currency` / `blockingClosureTxIds`), which the op forms need to drive the
 * cash-sleeve gate + the edit-blocked notice. This keeps the full error body.
 */
async function postPortfolioOperationRaw<T>(
  path: string,
  body: unknown
): Promise<OpResult<T>> {
  const url = `${_serverUrl}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (_authToken) headers["Authorization"] = `Bearer ${_authToken}`;

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logger.error("api", `POST ${path} — network error`, { detail });
    return { ok: false, status: 0, error: { error: `Network error: ${detail}` } };
  }
  const ms = Date.now() - start;
  const parsed = await safeParseJson(res);

  if (!res.ok) {
    const errBody: OpErrorInfo =
      parsed && typeof parsed === "object"
        ? (parsed as OpErrorInfo)
        : { error: `HTTP ${res.status}` };
    if (typeof errBody.error !== "string") errBody.error = `HTTP ${res.status}`;
    logger.warn("api", `POST ${path} → ${res.status} (${ms}ms)`, {
      code: errBody.code,
    });
    return { ok: false, status: res.status, error: errBody };
  }

  logger.debug("api", `POST ${path} → ${res.status} (${ms}ms)`, {
    shape: describeShape(parsed),
  });
  return { ok: true, status: res.status, data: parsed as T };
}

export const api = {
  get<T>(path: string): Promise<ApiResponse<T>> {
    return request<T>(path);
  },

  post<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
    return request<T>(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  put<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return request<T>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },

  patch<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return request<T>(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  delete<T>(path: string): Promise<ApiResponse<T>> {
    return request<T>(path, { method: "DELETE" });
  },
};

// Typed endpoint helpers
import type {
  Account,
  AccountBalance,
  Transaction,
  TransactionFormData,
  BudgetWithSpending,
  Category,
  DashboardData,
  HealthScoreData,
  GoalWithProgress,
  PortfolioOverview,
  PortfolioHoldingRow,
  PortfolioPerformance,
  RealizedGainsResult,
  DividendIncomeResult,
  LotRow,
  OperationLoadData,
  PortfolioOpKey,
  PortfolioOpBody,
  HoldingFormData,
  CashSleevePayload,
  OpResult,
  OpErrorInfo,
  TransferPayload,
  RegisterPayload,
  AccountFormData,
  CategoryFormData,
  GoalFormData,
  Announcement,
  FeedbackFormData,
  Split,
  SplitInput,
  IncomeStatement,
  BalanceSheet,
  ReportTrends,
  YoYReport,
  ReportPeriod,
  ReportGroupBy,
  InboxAccount,
  AccountMode,
  ReconcileSuggestions,
  AutoRuleRecent,
  BankRowCommitBody,
  Goal,
  GoalEditData,
  CategoryEditData,
  AccountEditData,
  AccountDetailRow,
  ReconcileThresholds,
} from "../../../shared/types";

// Shared report query params. The date range + business + display currency are
// common to the income-statement, trends and sankey surfaces; trends adds
// granularity + group-by.
export interface ReportRangeParams {
  startDate: string;
  endDate: string;
  isBusiness?: boolean;
  currency?: string;
}
export interface ReportTrendsParams extends ReportRangeParams {
  period: ReportPeriod;
  groupBy: ReportGroupBy;
}

function reportRangeQuery(p: ReportRangeParams): string {
  const parts = [`startDate=${p.startDate}`, `endDate=${p.endDate}`];
  if (p.isBusiness) parts.push("business=true");
  if (p.currency) parts.push(`currency=${encodeURIComponent(p.currency)}`);
  return parts.join("&");
}

// --- Raw shape of GET /api/dashboard (server-computed, pre-aggregation) ---
// The mobile DashboardScreen wants a flattened `DashboardData`; the backend
// returns the raw pieces the web dashboard composes client-side. We mirror that
// composition in `composeDashboard()` below.
interface RawIncomeExpenseRow {
  month: string;
  type: "I" | "E";
  total: number;
}
interface RawDashboardResponse {
  displayCurrency?: string;
  balances?: AccountBalance[];
  incomeVsExpenses?: RawIncomeExpenseRow[];
  spendingByCategory?: Array<{ categoryId: number; categoryName?: string; total: number }>;
  netWorthOverTime?: Array<{ month: string; cumulative: number; currency?: string }>;
}

/**
 * Compose the flattened `DashboardData` the mobile screen renders from the raw
 * `/api/dashboard` payload + a small recent-transactions fetch. Mirrors the web
 * dashboard's client-side math (src/app/(app)/dashboard/page.tsx): net worth =
 * sum of converted asset balances + (negative) converted liability balances;
 * monthly income/expenses = the latest month in incomeVsExpenses.
 */
async function composeDashboard(): Promise<ApiResponse<DashboardData>> {
  const rawRes = await api.get<RawDashboardResponse>("/api/dashboard");
  if (!rawRes.success) return rawRes;
  const raw = rawRes.data ?? {};

  // Recent transactions are a separate endpoint; a failure here must not blank
  // the whole dashboard — degrade to an empty list and log it.
  let recentTransactions: Transaction[] = [];
  // Use the unwrapping helper, NOT a raw api.get — the REST route returns the
  // paginated `{ data, total }` envelope (issue #59), so a bare api.get would
  // see a non-array and log a spurious "fetch failed" WARN on every 200.
  const txRes = await endpoints.getTransactions("limit=5&sort=date&sortDir=desc");
  if (txRes.success && Array.isArray(txRes.data)) {
    recentTransactions = txRes.data;
  } else {
    logger.warn("dashboard", "recent-transactions fetch failed", {
      error: txRes.success ? "not-an-array" : txRes.error,
    });
  }

  const balances = raw.balances ?? [];
  const balVal = (b: AccountBalance) => b.convertedBalance ?? b.balance ?? 0;
  const totalAssets = balances
    .filter((b) => b.accountType === "A")
    .reduce((s, b) => s + balVal(b), 0);
  const totalLiabilitiesSigned = balances
    .filter((b) => b.accountType === "L")
    .reduce((s, b) => s + balVal(b), 0);
  const netWorth = totalAssets + totalLiabilitiesSigned;

  const monthMap = new Map<string, { income: number; expenses: number }>();
  for (const row of raw.incomeVsExpenses ?? []) {
    const entry = monthMap.get(row.month) ?? { income: 0, expenses: 0 };
    if (row.type === "I") entry.income = row.total;
    else if (row.type === "E") entry.expenses = Math.abs(row.total);
    monthMap.set(row.month, entry);
  }
  const months = Array.from(monthMap.keys()).sort();
  const latest = months.length ? monthMap.get(months[months.length - 1])! : { income: 0, expenses: 0 };
  const monthlyIncome = latest.income;
  const monthlyExpenses = latest.expenses;
  const savingsRate =
    monthlyIncome > 0 ? ((monthlyIncome - monthlyExpenses) / monthlyIncome) * 100 : 0;

  const data: DashboardData = {
    netWorth,
    totalAssets,
    // Liabilities are stored as negative balances; surface the magnitude for display.
    totalLiabilities: Math.abs(totalLiabilitiesSigned),
    monthlyIncome,
    monthlyExpenses,
    savingsRate,
    recentTransactions,
    accountBalances: balances.map((b) => ({
      name: b.accountName ?? "Account",
      balance: balVal(b),
      type: b.accountType,
      currency: raw.displayCurrency ?? b.currency ?? "CAD",
    })),
  };

  logger.info("dashboard", "composed", {
    balances: balances.length,
    recent: recentTransactions.length,
    monthsTracked: months.length,
  });
  return { success: true, data };
}

export const endpoints = {
  // Auth — account login. `identifier` accepts username OR email; the backend
  // login route resolves either via getUserByIdentifier. There is no longer a
  // self-hosted passphrase/unlock path (the /api/auth/unlock endpoint was
  // removed — GET /api/auth/session is the single identity source).
  login: (identifier: string, password: string) =>
    authRequest("/api/auth/login", { identifier, password }),
  register: (payload: RegisterPayload) =>
    authRequest("/api/auth/register", payload),

  // Dashboard — composed client-side from /api/dashboard + recent transactions.
  getDashboard: () => composeDashboard(),

  // Health Score — /api/health-score returns { score, grade, components } (bare).
  getHealthScore: () => api.get<HealthScoreData>("/api/health-score"),

  // Accounts (no balances — name/type/group/currency only)
  getAccounts: () => api.get<Account[]>("/api/accounts"),
  createAccount: (d: AccountFormData) => api.post<Account>("/api/accounts", d),
  // Full decrypted account rows (incl. type/group/note/alias/archived/mode) for
  // the account-detail edit prefill + reconciliation-mode picker. Same route as
  // getAccounts; the richer AccountDetailRow type just stops narrowing fields.
  getAccountsDetailed: () => api.get<AccountDetailRow[]>("/api/accounts"),
  // Edit goes through the COLLECTION route with `id` in the body (PUT). Names
  // are sent plaintext; the server re-encrypts via buildNameFields.
  updateAccount: (d: AccountEditData) => api.put<Account>("/api/accounts", d),
  // Per-financial-account delete (NOT the destructive whole-account deletion —
  // that's `deleteAccount(password)` below). 409 with an "archive it instead"
  // message when the account still has linked transactions/records.
  deleteAccountById: (id: number) =>
    api.delete<{ ok?: boolean }>(`/api/accounts?id=${id}`),

  // Per-account balances live in the dashboard payload (computed + FX-converted).
  getAccountBalances: async (): Promise<ApiResponse<AccountBalance[]>> => {
    const res = await api.get<RawDashboardResponse>("/api/dashboard");
    if (!res.success) return res;
    return { success: true, data: res.data?.balances ?? [] };
  },

  // Transactions. The REST route returns a paginated envelope
  // `{ data: Transaction[], total }` (issue #59), NOT a bare array — so unwrap
  // to Transaction[] here so every caller (list, account detail, dashboard
  // recents) gets an array. Defensive: also accept a bare array.
  getTransactions: async (params?: string): Promise<ApiResponse<Transaction[]>> => {
    const res = await api.get<unknown>(`/api/transactions${params ? `?${params}` : ""}`);
    if (!res.success) return res;
    const body = res.data as Transaction[] | { data?: Transaction[] } | null;
    const rows: Transaction[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
        ? (body!.data as Transaction[])
        : [];
    return { success: true, data: rows };
  },
  createTransaction: (data: TransactionFormData) =>
    api.post<Transaction>("/api/transactions", data),
  updateTransaction: (data: Partial<TransactionFormData> & { id: number }) =>
    api.put<Transaction>("/api/transactions", data),
  deleteTransaction: (id: number) =>
    api.delete<void>(`/api/transactions?id=${id}`),

  // Transaction splits — view metadata that divides a parent across rows. All
  // three return bare JSON: GET → Split[] (decrypted), POST → Split[] (201,
  // atomic delete-then-insert), DELETE → { success: true }. request() wraps the
  // GET/POST arrays into the { success, data } shape; the DELETE body already
  // looks enveloped so request() passes it through (res.success === true).
  getSplits: (transactionId: number) =>
    api.get<Split[]>(`/api/transactions/splits?transactionId=${transactionId}`),
  // Atomic replace — always send the FULL array. Server encrypts note/tags +
  // derives entered_* from the parent, so the client sends only plaintext +
  // the account-currency amount.
  saveSplits: (transactionId: number, splits: SplitInput[]) =>
    api.post<Split[]>("/api/transactions/splits", { transactionId, splits }),
  deleteSplits: (transactionId: number) =>
    api.delete<{ success: boolean }>(`/api/transactions/splits?transactionId=${transactionId}`),

  // Categories
  getCategories: () => api.get<Category[]>("/api/categories"),
  createCategory: (d: CategoryFormData) => api.post<Category>("/api/categories", d),
  // PUT with `id` in body; DELETE refuses with 409 + a message when the
  // category is still referenced by transactions (mobile surfaces the message).
  updateCategory: (d: CategoryEditData) => api.put<Category>("/api/categories", d),
  deleteCategory: (id: number) =>
    api.delete<{ success?: boolean }>(`/api/categories?id=${id}`),

  // Goals — bare array of Goal + server-computed progress fields.
  getGoals: () => api.get<GoalWithProgress[]>("/api/goals"),
  createGoal: (d: GoalFormData) => api.post<GoalWithProgress>("/api/goals", d),
  // PUT with `id` in body (collection route); DELETE by `?id=`.
  updateGoal: (d: GoalEditData) => api.put<Goal>("/api/goals", d),
  deleteGoal: (id: number) =>
    api.delete<{ success?: boolean }>(`/api/goals?id=${id}`),

  // One-tap onboarding: seeds a full demo-grade dataset (idempotent) —
  // categories incl. Dividends, 5 accounts (Chequing/Savings/Visa + Brokerage
  // & TFSA investment accounts), ~6 months of transactions, a funded portfolio
  // with holdings/cash-sleeves/buys/sells, cash dividends, goals, loans,
  // subscriptions, and current-month budgets. Returns the enveloped
  // `{ success, transactionsCreated, summary }` shape directly (request()
  // passes it through unchanged), so `transactionsCreated` rides at the top
  // level, NOT under `.data`.
  loadSampleData: () =>
    api.post<{ transactionsCreated: number }>("/api/onboarding/sample-data"),

  // Portfolio — consolidated holdings + summary (bare JSON → request() wraps).
  getPortfolioOverview: () => api.get<PortfolioOverview>("/api/portfolio/overview"),

  // GET /api/portfolio — bare array of holdings (decrypted name/symbol +
  // currentShares + isCash). Powers the op-form pickers + holding selectors.
  getPortfolioHoldings: () => api.get<PortfolioHoldingRow[]>("/api/portfolio"),

  // Reporting — these routes DO return the { success, data } envelope, which
  // request() passes through unchanged, so res.data is the inner payload.
  getPortfolioPerformance: (period: string, accountId?: number | null) =>
    api.get<PortfolioPerformance>(
      `/api/portfolio/performance?period=${encodeURIComponent(period)}${
        accountId != null ? `&accountId=${accountId}` : ""
      }`
    ),
  getRealizedGains: (params?: string) =>
    api.get<RealizedGainsResult>(
      `/api/portfolio/realized-gains${params ? `?${params}` : ""}`
    ),
  getDividends: (params?: string) =>
    api.get<DividendIncomeResult>(
      `/api/portfolio/dividends${params ? `?${params}` : ""}`
    ),
  getPortfolioLots: (holdingId: number, accountId?: number | null) =>
    api.get<{ lots: LotRow[] }>(
      `/api/portfolio/lots?holdingId=${holdingId}&openOnly=1${
        accountId != null ? `&accountId=${accountId}` : ""
      }`
    ),
  // Edit-prefill load for a portfolio op (either leg id) — enveloped.
  loadPortfolioOperation: (id: number) =>
    api.get<OperationLoadData>(`/api/portfolio/operations/load?id=${id}`),

  // Operation POSTs — structured-error aware (see postPortfolioOperationRaw).
  postPortfolioOperation: <T = { id: number }>(
    op: PortfolioOpKey,
    body: PortfolioOpBody
  ): Promise<OpResult<T>> =>
    postPortfolioOperationRaw<T>(`/api/portfolio/operations/${op}`, body),

  // Cash sleeve — 201 on create, 409 (code "duplicate_cash_sleeve") when one
  // already exists. Callers treat the dup as success (the sleeve is present).
  createCashSleeve: (payload: CashSleevePayload) =>
    postPortfolioOperationRaw<{ id: number; currency: string }>(
      "/api/portfolio/holdings/cash-sleeve",
      payload
    ),

  // Create a new (non-cash) holding before a Buy when the symbol isn't yet in
  // the account. Names sent plaintext; the server encrypts via buildNameFields.
  createPortfolioHolding: (payload: HoldingFormData) =>
    api.post<{ id: number }>("/api/portfolio", payload),

  // Transfer — atomic same-currency pair. Cross-currency (FX) transfers are
  // refused server-side (409 fx-currency-needs-override) and must use the web.
  recordTransfer: (payload: TransferPayload) =>
    api.post<unknown>("/api/transactions/transfer", payload),

  // Budgets
  getBudgets: (month?: string, spending = true) =>
    api.get<BudgetWithSpending[]>(
      `/api/budgets?spending=1${month ? `&month=${month}` : ""}`
    ),

  // Reports — all bare JSON (request() wraps). The income-statement +
  // balance-sheet routes FX-convert totals server-side and echo back the
  // resolved `displayCurrency`; trends + yoy do NOT convert (they SUM raw
  // amounts), matching the web /reports behavior. Detail screens read the
  // display currency off the income-statement/balance-sheet response and pass
  // it down as a route param (trends/sankey/yoy have no currency field).
  getIncomeStatement: (p: ReportRangeParams) =>
    api.get<IncomeStatement>(
      `/api/reports?type=income-statement&${reportRangeQuery(p)}`
    ),
  getBalanceSheet: (p: { endDate: string; currency?: string }) =>
    api.get<BalanceSheet>(
      `/api/reports?type=balance-sheet&endDate=${p.endDate}${
        p.currency ? `&currency=${encodeURIComponent(p.currency)}` : ""
      }`
    ),
  getReportTrends: (p: ReportTrendsParams) =>
    api.get<ReportTrends>(
      `/api/reports/trends?${reportRangeQuery(p)}&period=${p.period}&groupBy=${p.groupBy}`
    ),
  getYoY: (p: { year1: number; year2: number; currency?: string }) =>
    api.get<YoYReport>(
      `/api/reports/yoy?year1=${p.year1}&year2=${p.year2}${
        p.currency ? `&currency=${encodeURIComponent(p.currency)}` : ""
      }`
    ),

  // Announcements — active broadcast items + per-user read flag (bare array).
  getAnnouncements: () => api.get<Announcement[]>("/api/announcements"),
  // Mark an announcement read/dismissed (idempotent server-side).
  markAnnouncementRead: (id: number) =>
    api.post<{ ok: boolean }>(`/api/announcements/${id}/read`),

  // Feedback — submit a bug report / idea. Server stores it + emails the
  // maintainer. `appVersion: "mobile"` distinguishes mobile submissions.
  submitFeedback: (payload: FeedbackFormData) =>
    api.post<{ ok: boolean; id: number }>("/api/feedback", {
      ...payload,
      appVersion: payload.appVersion ?? "mobile",
    }),

  // ─── Reconcile inbox (account-anchored Approve-each / Auto-pilot cards) ───
  // Account list WITH the per-account reconciliation `mode` + investment flag +
  // decrypted name/alias. GET /api/accounts already returns these fields (the
  // base `getAccounts` types them away); the inbox needs them, hence a
  // dedicated helper with the richer InboxAccount shape.
  getInboxAccounts: () => api.get<InboxAccount[]>("/api/accounts"),

  // Three-layer reconcile snapshot for one account. ENVELOPED ({success,data})
  // — request() passes it through, so res.data is the inner payload. Needs the
  // DEK for fuzzy matching (423 without; mobile sessions carry it).
  getReconcileSuggestions: (
    accountId: number,
    dateMin?: string,
    dateMax?: string,
  ) => {
    const parts = [`accountId=${accountId}`];
    if (dateMin) parts.push(`dateMin=${encodeURIComponent(dateMin)}`);
    if (dateMax) parts.push(`dateMax=${encodeURIComponent(dateMax)}`);
    return api.get<ReconcileSuggestions>(
      `/api/reconcile/suggestions?${parts.join("&")}`,
    );
  },

  // Commit one bank row → ledger with a chosen category (Approve-each lens).
  // Bare structured error `{ error, code? }` on 4xx (sign-vs-category /
  // investment-account guards) — use the structured-error-aware helper so the
  // message survives instead of being collapsed to a string by request().
  approveBankRow: (bankId: string, body: BankRowCommitBody) =>
    postPortfolioOperationRaw<{ success: boolean; data: { transactionId: number } }>(
      `/api/bank-transactions/${encodeURIComponent(bankId)}/approve`,
      body,
    ),

  // Auto-pilot companion — commit an unmatched bank row with a chosen category.
  categorizeBankRow: (bankId: string, body: BankRowCommitBody) =>
    postPortfolioOperationRaw<{ success: boolean; data: { transactionId: number } }>(
      `/api/bank-transactions/${encodeURIComponent(bankId)}/categorize`,
      body,
    ),

  // Recent rule-fired rows for the Auto-pilot "Reconciled" banner. Enveloped.
  getAutoRuleRecent: (accountId: number, days?: number) =>
    api.get<AutoRuleRecent>(
      `/api/reconcile/auto-rule-recent?accountId=${accountId}${
        days ? `&days=${days}` : ""
      }`,
    ),

  // Persist the per-account reconciliation policy. Enveloped; request() passes
  // the { success, data } through, so res.data is { id, mode }.
  setAccountMode: (accountId: number, mode: AccountMode) =>
    api.patch<{ id: number; mode: AccountMode }>(
      `/api/accounts/${accountId}/mode`,
      { mode },
    ),

  // Per-row bank-ledger delete. The inbox cards only ever surface UNLINKED bank
  // rows, which delete cleanly; a linked row would 409 (surfaced as an error).
  deleteBankRow: (bankId: string) =>
    api.delete<{ success?: boolean }>(
      `/api/bank-transactions/${encodeURIComponent(bankId)}`,
    ),

  // ─── Settings (P4 expansion) ───────────────────────────────────────────
  // Display currency — bare `{ displayCurrency }` (request() wraps → res.data).
  // PUT returns the same bare shape on 2xx, or 400 `{ error, code }` for an
  // unsupported code (collapsed to res.error by request()).
  getDisplayCurrency: () =>
    api.get<{ displayCurrency: string }>("/api/settings/display-currency"),
  setDisplayCurrency: (displayCurrency: string) =>
    api.put<{ displayCurrency: string }>("/api/settings/display-currency", {
      displayCurrency,
    }),

  // Reconcile thresholds — ENVELOPED `{ success, data: { thresholds, isDefault } }`.
  // request() passes the envelope through, so res.data is the inner object.
  getReconcileThresholds: () =>
    api.get<{ thresholds: ReconcileThresholds; isDefault: boolean }>(
      "/api/settings/reconcile-thresholds",
    ),
  setReconcileThresholds: (t: ReconcileThresholds) =>
    api.put<{ thresholds: ReconcileThresholds; isDefault: boolean }>(
      "/api/settings/reconcile-thresholds",
      t,
    ),

  // Destructive account actions. Both are account-session only (the backend
  // rejects API-key auth) and require the same confirmation phrase the web UI
  // sends. `wipeData` deletes all data but keeps the login (DEK re-wrapped);
  // `deleteAccount` removes the user row too. Either way the server evicts the
  // session DEK, so the caller must sign out afterwards. MFA-gated accounts
  // can't reach here (mobile login already blocks them) — the server returns a
  // 401 surfaced as the error string if it ever does.
  wipeData: (password: string) =>
    api.post<{ success?: boolean }>("/api/auth/wipe-account", {
      password,
      confirmation: "WIPE",
    }),
  deleteAccount: (password: string) =>
    api.post<{ success?: boolean }>("/api/auth/delete-account", {
      password,
      confirmation: "DELETE",
    }),
};
