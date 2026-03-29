import { test, expect } from "@playwright/test";
import { ensureUnlocked } from "./helpers";

test.describe("Transactions API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("GET /api/transactions returns transaction list", async ({
    request,
  }) => {
    const res = await request.get("/api/transactions");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty("data");
    expect(data).toHaveProperty("total");
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
  });

  test("transaction objects have expected fields", async ({ request }) => {
    const res = await request.get("/api/transactions");
    const data = await res.json();
    const tx = data.data[0];
    expect(tx).toHaveProperty("id");
    expect(tx).toHaveProperty("date");
    expect(tx).toHaveProperty("amount");
    expect(tx).toHaveProperty("accountId");
  });

  test("GET /api/transactions supports limit parameter", async ({
    request,
  }) => {
    const res = await request.get("/api/transactions?limit=3");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.data.length).toBeLessThanOrEqual(3);
  });

  test("GET /api/transactions supports offset parameter", async ({
    request,
  }) => {
    const res = await request.get("/api/transactions?limit=5&offset=5");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
  });

  test("GET /api/transactions supports date range filter", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/transactions?startDate=2026-01-01&endDate=2026-12-31"
    );
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
  });

  test("POST /api/transactions creates a transaction", async ({ request }) => {
    // Get a category first
    const catRes = await request.get("/api/categories");
    const categories = await catRes.json();
    const expenseCat = categories.find(
      (c: { type: string }) => c.type === "E"
    );

    const res = await request.post("/api/transactions", {
      data: {
        date: "2026-03-29",
        amount: -42.0,
        accountId: 1,
        categoryId: expenseCat.id,
        currency: "CAD",
        payee: "E2E Test Store",
        note: "API integration test",
      },
    });
    expect(res.ok()).toBe(true);
    const created = await res.json();
    expect(created).toHaveProperty("id");
  });

  test("PUT /api/transactions updates a transaction", async ({ request }) => {
    // Get an existing transaction
    const listRes = await request.get("/api/transactions?limit=1");
    const data = await listRes.json();
    const tx = data.data[0];

    const res = await request.put("/api/transactions", {
      data: {
        id: tx.id,
        note: "Updated by E2E test",
      },
    });
    expect(res.ok()).toBe(true);
  });

  test("DELETE /api/transactions removes transaction", async ({ request }) => {
    // Create one first
    const catRes = await request.get("/api/categories");
    const categories = await catRes.json();
    const cat = categories[0];

    const createRes = await request.post("/api/transactions", {
      data: {
        date: "2026-03-29",
        amount: -1.0,
        accountId: 1,
        categoryId: cat.id,
        currency: "CAD",
        payee: "To Be Deleted",
      },
    });
    const created = await createRes.json();

    const deleteRes = await request.delete(
      `/api/transactions?id=${created.id}`
    );
    expect(deleteRes.ok()).toBe(true);
  });
});
