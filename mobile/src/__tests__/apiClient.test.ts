import { api, getServerUrl, setServerUrl, endpoints } from "../api/client";

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
        json: () => Promise.resolve({ success: true, data: [] }),
      });

      await api.get("/api/accounts");

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/accounts", {
        headers: { "Content-Type": "application/json" },
      });
    });

    it("returns parsed JSON response", async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ success: true, data: [{ id: 1 }] }),
      });

      const result = await api.get("/api/accounts");
      expect(result).toEqual({ success: true, data: [{ id: 1 }] });
    });
  });

  describe("api.post", () => {
    it("makes POST request with body", async () => {
      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ success: true, data: {} }),
      });

      await api.post("/api/auth/unlock", { action: "unlock", passphrase: "test" });

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/api/auth/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unlock", passphrase: "test" }),
      });
    });

    it("makes POST request without body", async () => {
      mockFetch.mockResolvedValue({
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
        json: () => Promise.resolve({ success: true, data: {} }),
      });
    });

    it("getUnlockStatus calls correct path", async () => {
      await endpoints.getUnlockStatus();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/auth/unlock",
        expect.any(Object)
      );
    });

    it("unlock sends correct payload", async () => {
      await endpoints.unlock("mypass");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/auth/unlock",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "unlock", passphrase: "mypass" }),
        })
      );
    });

    it("lock sends correct payload", async () => {
      await endpoints.lock();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/auth/unlock",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "lock" }),
        })
      );
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
});
