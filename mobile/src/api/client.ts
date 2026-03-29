// Typed API client for connecting to the PF Next.js backend
import type { ApiResponse } from "../../../shared/types";

let _serverUrl = "http://localhost:3000";

export function setServerUrl(url: string) {
  _serverUrl = url.replace(/\/$/, "");
}

export function getServerUrl(): string {
  return _serverUrl;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = `${_serverUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return res.json() as Promise<ApiResponse<T>>;
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
  Transaction,
  TransactionFormData,
  Budget,
  BudgetWithSpending,
  Category,
  DashboardData,
  HealthScoreData,
  UnlockStatus,
} from "../../../shared/types";

export const endpoints = {
  // Auth
  getUnlockStatus: () => api.get<UnlockStatus>("/api/auth/unlock"),
  unlock: (passphrase: string) =>
    api.post<{ unlocked: boolean }>("/api/auth/unlock", {
      action: "unlock",
      passphrase,
    }),
  lock: () =>
    api.post<{ unlocked: boolean }>("/api/auth/unlock", { action: "lock" }),

  // Dashboard
  getDashboard: () => api.get<DashboardData>("/api/dashboard"),

  // Health Score
  getHealthScore: () => api.get<HealthScoreData>("/api/health-score"),

  // Accounts
  getAccounts: () => api.get<Account[]>("/api/accounts"),

  // Transactions
  getTransactions: (params?: string) =>
    api.get<Transaction[]>(`/api/transactions${params ? `?${params}` : ""}`),
  createTransaction: (data: TransactionFormData) =>
    api.post<Transaction>("/api/transactions", data),
  updateTransaction: (data: Partial<TransactionFormData> & { id: number }) =>
    api.put<Transaction>("/api/transactions", data),
  deleteTransaction: (id: number) =>
    api.delete<void>(`/api/transactions?id=${id}`),

  // Categories
  getCategories: () => api.get<Category[]>("/api/categories"),

  // Budgets
  getBudgets: (month?: string, spending = true) =>
    api.get<BudgetWithSpending[]>(
      `/api/budgets?spending=1${month ? `&month=${month}` : ""}`
    ),
};
