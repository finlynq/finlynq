import { test, expect } from "@playwright/test";
import { ensureUnlocked } from "./helpers";

test.describe("Goals API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("GET /api/goals returns list", async ({ request }) => {
    const res = await request.get("/api/goals");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("POST /api/goals creates a goal", async ({ request }) => {
    const res = await request.post("/api/goals", {
      data: {
        name: "E2E Emergency Fund",
        type: "savings",
        targetAmount: 10000,
        deadline: "2026-12-31",
        priority: 1,
      },
    });
    expect(res.ok()).toBe(true);
    const created = await res.json();
    expect(created).toHaveProperty("id");
  });

  test("created goal appears in list", async ({ request }) => {
    const name = `Goal ${Date.now()}`;
    await request.post("/api/goals", {
      data: {
        name,
        type: "savings",
        targetAmount: 5000,
        priority: 2,
      },
    });

    const res = await request.get("/api/goals");
    const goals = await res.json();
    const found = goals.find((g: { name: string }) => g.name === name);
    expect(found).toBeDefined();
  });
});
