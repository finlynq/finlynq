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
  Budget,
  Category,
  DashboardData,
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

  // Accounts
  getAccounts: () => api.get<Account[]>("/api/accounts"),

  // Transactions
  getTransactions: (params?: string) =>
    api.get<Transaction[]>(`/api/transactions${params ? `?${params}` : ""}`),

  // Categories
  getCategories: () => api.get<Category[]>("/api/categories"),

  // Budgets
  getBudgets: (month?: string) =>
    api.get<Budget[]>(`/api/budgets${month ? `?month=${month}` : ""}`),
};
