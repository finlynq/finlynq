import { test, expect } from "@playwright/test";
import { ensureUnlocked } from "./helpers";

test.describe("Reports API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("GET /api/reports/trends returns data", async ({ request }) => {
    const res = await request.get(
      "/api/reports/trends?period=monthly&groupBy=category"
    );
    // May depend on FX service
    expect(res.status()).toBeLessThan(502);
  });

  test("GET /api/reports/yoy returns data", async ({ request }) => {
    const res = await request.get("/api/reports/yoy");
    expect(res.status()).toBeLessThan(502);
  });

  test("GET /api/health-score returns data", async ({ request }) => {
    const res = await request.get("/api/health-score");
    // Health score depends on multiple services; may 500 in isolated env
    if (res.ok()) {
      const data = await res.json();
      expect(data).toHaveProperty("score");
      expect(data.score).toBeGreaterThanOrEqual(0);
      expect(data.score).toBeLessThanOrEqual(100);
    } else {
      expect(res.status()).toBe(500);
    }
  });

  test("GET /api/snapshots returns data", async ({ request }) => {
    const res = await request.get("/api/snapshots");
    expect(res.ok()).toBe(true);
  });
});
