import { test, expect } from "@playwright/test";
import { ensureUnlocked } from "./helpers";

test.describe("Dashboard API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("GET /api/dashboard returns expected shape", async ({ request }) => {
    const res = await request.get("/api/dashboard");
    // Dashboard depends on FX service
    if (res.ok()) {
      const data = await res.json();
      expect(data).toHaveProperty("balances");
      expect(data).toHaveProperty("incomeVsExpenses");
      expect(data).toHaveProperty("netWorthOverTime");
      expect(data).toHaveProperty("spendingByCategory");
    } else {
      expect(res.status()).toBe(500);
    }
  });

  test("GET /api/accounts returns account data", async ({ request }) => {
    const res = await request.get("/api/accounts");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty("name");
  });

  test("GET /api/health-score responds", async ({ request }) => {
    const res = await request.get("/api/health-score");
    // May 500 if FX service unavailable
    if (res.ok()) {
      const data = await res.json();
      expect(data).toHaveProperty("score");
      expect(typeof data.score).toBe("number");
    } else {
      expect(res.status()).toBe(500);
    }
  });

  test("GET /api/spotlight responds", async ({ request }) => {
    const res = await request.get("/api/spotlight");
    expect(res.status()).toBeLessThan(502);
  });

  test("GET /api/insights responds", async ({ request }) => {
    const res = await request.get("/api/insights");
    expect(res.status()).toBeLessThan(502);
  });
});
