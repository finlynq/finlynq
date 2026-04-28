import { test, expect } from "@playwright/test";
import { ensureUnlocked } from "./helpers";

test.describe("Loans API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("GET /api/loans returns data", async ({ request }) => {
    const res = await request.get("/api/loans");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("POST /api/loans creates a loan", async ({ request }) => {
    const res = await request.post("/api/loans", {
      data: {
        name: "E2E Test Mortgage",
        type: "mortgage",
        principal: 300000,
        annualRate: 5.5,
        termMonths: 300,
        startDate: "2026-01-01",
        paymentFrequency: "monthly",
      },
    });
    expect(res.ok()).toBe(true);
  });
});

test.describe("Subscriptions API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("GET /api/subscriptions returns data", async ({ request }) => {
    const res = await request.get("/api/subscriptions");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

test.describe("Portfolio API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("GET /api/portfolio returns data", async ({ request }) => {
    const res = await request.get("/api/portfolio");
    expect(res.ok()).toBe(true);
  });
});

test.describe("Import API", () => {
  test.beforeEach(async ({ request }) => {
    await ensureUnlocked(request);
  });

  test("POST /api/import/preview requires file upload", async ({
    request,
  }) => {
    // Sending JSON instead of multipart should return 400 or 500
    const res = await request.post("/api/import/preview", {
      data: { content: "test" },
    });
    expect(res.ok()).toBe(false);
  });
});

test.describe("Page HTML Responses", () => {
  test("all 18 app pages return HTTP 200", async ({ request }) => {
    await ensureUnlocked(request);
    const pages = [
      "/",
      "/dashboard",
      "/accounts",
      "/budgets",
      "/transactions",
      "/reports",
      "/settings",
      "/import",
      "/goals",
      "/loans",
      "/portfolio",
      "/calendar",
      "/fire",
      "/subscriptions",
      "/tax",
      "/scenarios",
      "/chat",
      "/api-docs",
    ];

    for (const path of pages) {
      const res = await request.get(path);
      expect(
        res.ok(),
        `Expected ${path} to return 200 but got ${res.status()}`
      ).toBe(true);
    }
  });
});
