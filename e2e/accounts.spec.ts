import { test, expect } from "@playwright/test";
import { ensureUnlocked } from "./helpers";

test.describe("Accounts API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("GET /api/accounts returns list of accounts", async ({ request }) => {
    const res = await request.get("/api/accounts");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  test("account objects have required fields", async ({ request }) => {
    const res = await request.get("/api/accounts");
    const data = await res.json();
    const account = data[0];
    expect(account).toHaveProperty("id");
    expect(account).toHaveProperty("name");
    expect(account).toHaveProperty("type");
    expect(account).toHaveProperty("currency");
  });

  test("POST /api/accounts creates an account", async ({ request }) => {
    const res = await request.post("/api/accounts", {
      data: {
        name: `E2E Test Account ${Date.now()}`,
        type: "A",
        group: "Savings",
        currency: "CAD",
      },
    });
    expect(res.ok()).toBe(true);
    const created = await res.json();
    expect(created).toHaveProperty("id");
  });

  test("seeded Checking Account exists", async ({ request }) => {
    const res = await request.get("/api/accounts");
    const data = await res.json();
    const checking = data.find((a: { name: string }) =>
      a.name.toLowerCase().includes("checking")
    );
    expect(checking).toBeDefined();
    expect(checking.type).toBe("A");
  });
});
