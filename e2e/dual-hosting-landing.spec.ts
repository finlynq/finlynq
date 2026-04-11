/**
 * E2E: Dual-hosting landing page validation
 * Validates NS-41 (landing page) and NS-40 (dual-instance hosting) requirements.
 *
 * Test checklist (NS-44):
 *   1. Landing page renders with both hosting cards
 *   2. Cloud / Managed card is present and links correctly
 *   3. Self-hosted card is present and links correctly
 *   4. Mobile-responsive layout
 *   5. Root URL no longer immediately redirects to /dashboard
 */
import { test, expect } from "@playwright/test";

test.describe("Dual-hosting landing page", () => {
  test("root URL serves landing page (not a redirect to /dashboard)", async ({
    page,
  }) => {
    const response = await page.goto("/");
    // Should NOT be a transparent redirect ending at /dashboard
    expect(page.url()).not.toContain("/dashboard");
    expect(response?.status()).toBe(200);
  });

  test("landing page contains Cloud / Managed hosting card", async ({
    page,
  }) => {
    await page.goto("/");
    // Look for text that represents the managed / cloud option
    const cloudCard = page.getByText(/cloud|managed/i).first();
    await expect(cloudCard).toBeVisible();
  });

  test("landing page contains Self-Hosted card", async ({ page }) => {
    await page.goto("/");
    const selfHostedCard = page.getByText(/self.?host/i).first();
    await expect(selfHostedCard).toBeVisible();
  });

  test("Cloud card links to managed instance login", async ({ page }) => {
    await page.goto("/");
    // The cloud card should have an anchor pointing to the managed app path or subdomain
    const cloudLink = page.locator("a[href*='/app'], a[href*='app.']").first();
    await expect(cloudLink).toBeVisible();
  });

  test("Self-hosted card links to setup / download instructions", async ({
    page,
  }) => {
    await page.goto("/");
    // The self-hosted card should point to a setup/download page
    const selfHostLink = page
      .locator("a[href*='setup'], a[href*='download'], a[href*='get-started'], a[href*='self-host']")
      .first();
    await expect(selfHostLink).toBeVisible();
  });

  test("landing page is mobile-responsive (375px viewport)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    // Both cards should still be visible on mobile
    const cloudCard = page.getByText(/cloud|managed/i).first();
    const selfHostedCard = page.getByText(/self.?host/i).first();
    await expect(cloudCard).toBeVisible();
    await expect(selfHostedCard).toBeVisible();
    // No horizontal overflow
    const bodyWidth = await page.evaluate(
      () => document.body.scrollWidth
    );
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 1); // 1px tolerance
  });

  test("landing page title / heading is present", async ({ page }) => {
    await page.goto("/");
    // There should be some welcoming heading
    const heading = page.locator("h1, h2").first();
    await expect(heading).toBeVisible();
  });
});

test.describe("Self-hosted setup/download page", () => {
  test("setup page is reachable", async ({ request }) => {
    // The self-hosted path (exact path TBD by NS-41 implementer, common candidates)
    const candidates = ["/setup", "/download", "/get-started", "/self-hosted"];
    let found = false;
    for (const path of candidates) {
      const res = await request.get(path);
      if (res.ok()) {
        found = true;
        break;
      }
    }
    expect(
      found,
      "Expected at least one of /setup, /download, /get-started, /self-hosted to return 200"
    ).toBe(true);
  });

  test("setup page contains docker run instructions", async ({ page }) => {
    const candidates = ["/setup", "/download", "/get-started", "/self-hosted"];
    for (const path of candidates) {
      await page.goto(path);
      const dockerText = page.getByText(/docker run/i).first();
      const isVisible = await dockerText.isVisible().catch(() => false);
      if (isVisible) return; // found it
    }
    // If none found, fail explicitly
    throw new Error(
      "Could not find docker run instructions on any setup/download page"
    );
  });
});

test.describe("Managed instance login flow", () => {
  test("/app path (or subdomain) responds with login page", async ({
    request,
  }) => {
    const res = await request.get("/app");
    // /app should either return 200 (login page) or redirect to /app/login
    expect([200, 301, 302, 307, 308]).toContain(res.status());
  });
});
