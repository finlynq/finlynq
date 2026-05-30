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
  TransferPayload,
  RegisterPayload,
} from "../../../shared/types";

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

  // Categories
  getCategories: () => api.get<Category[]>("/api/categories"),

  // Goals — bare array of Goal + server-computed progress fields.
  getGoals: () => api.get<GoalWithProgress[]>("/api/goals"),

  // Portfolio (read-only on mobile) — consolidated holdings + summary.
  getPortfolioOverview: () => api.get<PortfolioOverview>("/api/portfolio/overview"),

  // Transfer — atomic same-currency pair. Cross-currency (FX) transfers are
  // refused server-side (409 fx-currency-needs-override) and must use the web.
  recordTransfer: (payload: TransferPayload) =>
    api.post<unknown>("/api/transactions/transfer", payload),

  // Budgets
  getBudgets: (month?: string, spending = true) =>
    api.get<BudgetWithSpending[]>(
      `/api/budgets?spending=1${month ? `&month=${month}` : ""}`
    ),
};
