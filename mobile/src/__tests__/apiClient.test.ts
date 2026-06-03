import {
  api,
  getServerUrl,
  setServerUrl,
  endpoints,
  getSession,
} from "../api/client";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("API Client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setServerUrl("http://localhost:3000");
  });

  describe("setServerUrl / getServerUrl", () => {
    it("returns default server URL", () => {
      setServerUrl("http://localhost:3000");
      expect(getServerUrl()).toBe("http://localhost:3000");
    });

    it("updates server URL", () => {
      setServerUrl("http://myserver:8080");
      expect(getServerUrl()).toBe("http://myserver:8080");
    });

    it("strips trailing slash", () => {
      setServerUrl("http://myserver:8080/");
      expect(getServerUrl()).toBe("http://myserver:8080");
    });
  });

  describe("api.get", () => {
    it("makes GET request to correct URL", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await api.get("/api/accounts");

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/accounts", {
        headers: { "Content-Type": "application/json" },
      });
    });

    // The REST API returns BARE JSON; request() synthesizes the { success, data }
    // envelope from the HTTP status. This is the load-bearing empty-data fix.
    it("wraps a bare REST array in the success envelope", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ id: 1 }]),
      });

      const result = await api.get("/api/accounts");
      expect(result).toEqual({ success: true, data: [{ id: 1 }] });
    });

    it("wraps a bare REST object in the success envelope", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ netWorth: 5 }),
      });

      const result = await api.get("/api/dashboard");
      expect(result).toEqual({ success: true, data: { netWorth: 5 } });
    });

    it("maps a non-OK response to an error envelope", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "Unauthorized" }),
      });

      const result = await api.get("/api/accounts");
      expect(result).toEqual({ success: false, error: "Unauthorized" });
    });

    it("falls back to HTTP <status> when an error body has no message", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve(null),
      });

      const result = await api.get("/api/accounts");
      expect(result).toEqual({ success: false, error: "HTTP 500" });
    });

    it("maps a thrown fetch to an error envelope (no throw)", async () => {
      mockFetch.mockRejectedValue(new TypeError("Network request failed"));

      const result = await api.get("/api/accounts");
      expect(result.success).toBe(false);
      expect("error" in result && result.error).toContain("Network request failed");
    });
  });

  describe("api.post", () => {
    it("makes POST request with body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: {} }),
      });

      await api.post("/api/transactions", { amount: 100 });

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      });
    });

    it("makes POST request without body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: {} }),
      });

      await api.post("/api/test");

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: undefined,
      });
    });
  });

  describe("api.put", () => {
    it("makes PUT request with body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: {} }),
      });

      await api.put("/api/transactions", { id: 1, amount: 100 });

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/transactions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, amount: 100 }),
      });
    });
  });

  describe("api.patch", () => {
    it("makes PATCH request with body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: {} }),
      });

      await api.patch("/api/items/1", { name: "updated" });

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/items/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "updated" }),
      });
    });
  });

  describe("api.delete", () => {
    it("makes DELETE request", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: {} }),
      });

      await api.delete("/api/transactions?id=1");

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/transactions?id=1", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  describe("endpoints", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: {} }),
      });
    });

    it("login sends {identifier, password} to /api/auth/login", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
        headers: { get: () => null },
      });
      await endpoints.login("alice", "hunter2hunter2");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/auth/login",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            identifier: "alice",
            password: "hunter2hunter2",
          }),
        })
      );
    });

    it("register forwards the full payload to /api/auth/register", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ success: true }),
        headers: { get: () => null },
      });
      const payload = {
        username: "alice",
        email: undefined,
        password: "correct horse battery",
        displayName: "Alice",
        acknowledgeNoRecovery: true,
      };
      await endpoints.register(payload);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/auth/register",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(payload),
        })
      );
    });

    it("getSession calls /api/auth/session", async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ authenticated: true, userId: "u1" }),
      });
      const session = await getSession();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/auth/session",
        expect.any(Object)
      );
      expect(session).toEqual({ authenticated: true, userId: "u1" });
    });

    it("getDashboard calls correct path", async () => {
      await endpoints.getDashboard();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/dashboard",
        expect.any(Object)
      );
    });

    it("getTransactions with params", async () => {
      await endpoints.getTransactions("limit=50&order=desc");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/transactions?limit=50&order=desc",
        expect.any(Object)
      );
    });

    it("getTransactions without params", async () => {
      await endpoints.getTransactions();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/transactions",
        expect.any(Object)
      );
    });

    it("deleteTransaction calls correct path", async () => {
      await endpoints.deleteTransaction(42);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/transactions?id=42",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("getBudgets with month", async () => {
      await endpoints.getBudgets("2026-03");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/budgets?spending=1&month=2026-03",
        expect.any(Object)
      );
    });

    it("getBudgets without month", async () => {
      await endpoints.getBudgets();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/budgets?spending=1",
        expect.any(Object)
      );
    });
  });

  describe("portfolio endpoints", () => {
    it("getPortfolioHoldings unwraps a bare REST array", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ id: 1, isCash: false }]),
      });
      const res = await endpoints.getPortfolioHoldings();
      expect(res).toEqual({ success: true, data: [{ id: 1, isCash: false }] });
    });

    it("postPortfolioOperation returns ok+data on 2xx", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ id: 7 }),
      });
      const res = await endpoints.postPortfolioOperation("buy", {
        accountId: 1,
        holdingId: 1,
        qty: 1,
        totalCost: 10,
        date: "2026-06-02",
      });
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ id: 7 });
    });

    // The load-bearing structured-error passthrough: code / currency / accountId
    // survive so the op form can drive the cash-sleeve gate + edit-blocked notice.
    it("postPortfolioOperation preserves a structured 4xx error body", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: "No USD cash sleeve",
            code: "cash_sleeve_not_found",
            currency: "USD",
            accountId: 5,
          }),
      });
      const res = await endpoints.postPortfolioOperation("buy", {
        accountId: 5,
        holdingId: 1,
        qty: 1,
        totalCost: 10,
        date: "2026-06-02",
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("cash_sleeve_not_found");
      expect(res.error?.currency).toBe("USD");
      expect(res.error?.accountId).toBe(5);
    });

    it("postPortfolioOperation preserves blockingClosureTxIds on 409", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            error: "blocked",
            code: "portfolio_edit_blocked",
            blockingClosureTxIds: [4821, 4830],
          }),
      });
      const res = await endpoints.postPortfolioOperation("buy", {
        accountId: 1,
        holdingId: 1,
        qty: 1,
        totalCost: 10,
        date: "2026-06-02",
        editId: 99,
      });
      expect(res.error?.blockingClosureTxIds).toEqual([4821, 4830]);
    });

    it("createCashSleeve surfaces the duplicate code on 409", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({ error: "exists", code: "duplicate_cash_sleeve", holdingId: 12 }),
      });
      const res = await endpoints.createCashSleeve({ accountId: 1, currency: "USD" });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("duplicate_cash_sleeve");
    });
  });

  // P4 — settings expansion endpoints.
  describe("settings + edit endpoints", () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    it("getDisplayCurrency GETs the settings route", async () => {
      await endpoints.getDisplayCurrency();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/settings/display-currency",
        expect.objectContaining({ headers: expect.any(Object) })
      );
    });

    it("setDisplayCurrency PUTs { displayCurrency }", async () => {
      await endpoints.setDisplayCurrency("USD");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/settings/display-currency",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ displayCurrency: "USD" }),
        })
      );
    });

    it("getReconcileThresholds passes an enveloped response through", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            success: true,
            data: { thresholds: { dateToleranceDays: 7 }, isDefault: true },
          }),
      });
      const res = await endpoints.getReconcileThresholds();
      expect(res.success).toBe(true);
      expect(res.success && res.data?.isDefault).toBe(true);
    });

    it("setReconcileThresholds PUTs the four-number payload", async () => {
      const t = {
        dateToleranceDays: 5,
        amountTolerancePct: 0.05,
        amountToleranceFloor: 25,
        scoreThreshold: 0.7,
      };
      await endpoints.setReconcileThresholds(t);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/settings/reconcile-thresholds",
        expect.objectContaining({ method: "PUT", body: JSON.stringify(t) })
      );
    });

    it("getAccountsDetailed GETs /api/accounts", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ id: 1, mode: "manual" }]),
      });
      const res = await endpoints.getAccountsDetailed();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/accounts",
        expect.any(Object)
      );
      expect(res).toEqual({ success: true, data: [{ id: 1, mode: "manual" }] });
    });

    it("updateAccount PUTs to the collection route with id in the body", async () => {
      await endpoints.updateAccount({ id: 3, name: "Renamed", archived: true });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/accounts",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ id: 3, name: "Renamed", archived: true }),
        })
      );
    });

    it("deleteAccountById DELETEs ?id= (distinct from the destructive auth delete)", async () => {
      await endpoints.deleteAccountById(3);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/accounts?id=3",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("updateGoal PUTs /api/goals with id", async () => {
      await endpoints.updateGoal({ id: 4, name: "Trip", targetAmount: 1000 });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/goals",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ id: 4, name: "Trip", targetAmount: 1000 }),
        })
      );
    });

    it("deleteGoal DELETEs /api/goals?id=", async () => {
      await endpoints.deleteGoal(4);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/goals?id=4",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("updateCategory PUTs /api/categories with id", async () => {
      await endpoints.updateCategory({ id: 6, name: "Dining", group: "Food" });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/categories",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ id: 6, name: "Dining", group: "Food" }),
        })
      );
    });

    it("deleteCategory DELETEs /api/categories?id= (surfaces 409 message)", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: "Cannot delete: 3 transactions reference this category" }),
      });
      const res = await endpoints.deleteCategory(6);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/categories?id=6",
        expect.objectContaining({ method: "DELETE" })
      );
      expect(res.success).toBe(false);
      expect(res.success === false && res.error).toContain("Cannot delete");
    });
  });
});
