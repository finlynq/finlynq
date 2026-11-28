/**
 * Onboarding wizard (2026-11-27, owner request): sample data is gone (people
 * who want to look around use the public demo), a new account gets a starter
 * set of categories, and the start options point at the real ways in.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const wizard = readFileSync("src/components/onboarding-wizard.tsx", "utf8");

describe("onboarding wizard", () => {
  it("no longer offers or calls sample data", () => {
    expect(wizard).not.toMatch(/sample-data/);
    expect(wizard).not.toMatch(/Load sample data/);
    expect(existsSync("src/app/api/onboarding/sample-data/route.ts")).toBe(false);
  });

  it("points people who want sample data at the demo", () => {
    expect(wizard).toMatch(/One-click demo/);
  });

  it("starter categories keep the exact Dividends name the dividend report looks up", () => {
    expect(wizard).toMatch(/name: "Dividends"/);
  });

  it("creates categories before budgets so budgets attach to them", () => {
    const cats = wizard.indexOf('postOk("/api/categories"');
    const budgets = wizard.indexOf('postOk("/api/budgets/seed"');
    expect(cats).toBeGreaterThan(-1);
    expect(budgets).toBeGreaterThan(cats);
  });

  it("every way to start has a destination", () => {
    for (const key of ["feed", "import", "migrate", "skip"]) {
      expect(wizard).toMatch(new RegExp(`key: "${key}" as const`));
      expect(wizard).toMatch(new RegExp(`\\n  ${key}: \\{`));
    }
    expect(wizard).toMatch(/href: "\/settings\/bank-feeds"/);
    expect(wizard).toMatch(/href: "\/settings\/import\?tab=migrate"/);
  });

  it("does not hardcode budget amounts that mean nothing in other currencies", () => {
    expect(wizard).not.toMatch(/amount: 600/);
  });
});
