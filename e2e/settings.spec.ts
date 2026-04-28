import { test, expect } from "@playwright/test";
import { ensureUnlocked } from "./helpers";

test.describe("Settings & Categories API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("GET /api/categories returns category list", async ({ request }) => {
    const res = await request.get("/api/categories");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  test("categories have required fields", async ({ request }) => {
    const res = await request.get("/api/categories");
    const data = await res.json();
    const cat = data[0];
    expect(cat).toHaveProperty("id");
    expect(cat).toHaveProperty("name");
    expect(cat).toHaveProperty("type");
    expect(["E", "I", "R"]).toContain(cat.type);
  });

  test("GET /api/rules returns rules list", async ({ request }) => {
    const res = await request.get("/api/rules");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});
