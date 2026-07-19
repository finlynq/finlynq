/**
 * FINLYNQ-130 — FX cache failures must degrade to a visible fallback.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(() => {
    throw new Error("legacy fx_rates schema");
  }),
}));

vi.mock("@/db", () => ({
  db: {
    select: selectMock,
  },
  schema: {
    fxOverrides: {
      userId: "user_id",
      currency: "currency",
      dateFrom: "date_from",
      dateTo: "date_to",
      rateToUsd: "rate_to_usd",
    },
    fxRates: {
      currency: "currency",
      date: "date",
      rateToUsd: "rate_to_usd",
    },
  },
}));

vi.mock("@/lib/market-fetch", () => ({
  marketFetch: vi.fn(async () => ({ ok: false })),
}));

import { getRateToUsdDetailed } from "@/lib/fx-service";

describe("FX cache fallback (FINLYNQ-130)", () => {
  it("returns CHF fallback plus a safe warning when cache lookup fails", async () => {
    const result = await getRateToUsdDetailed("CHF", "2026-07-19", "user-1");

    expect(result.source).toBe("fallback");
    expect(result.rate).toBe(1.13);
    expect(result.warning).toBe("FX cache unavailable; using live or fallback rate.");
    expect(selectMock).toHaveBeenCalled();
  });

  it("tracks a canonical migration instead of assuming the legacy pair schema", () => {
    const migration = readFileSync(
      resolve(__dirname, "../scripts/migrations/20260719_fx_rates_canonicalize.sql"),
      "utf8",
    );

    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS fx_rates/i);
    expect(migration).toMatch(/rate_to_usd/i);
    expect(migration).toMatch(/fx_rates_legacy/i);
    expect(migration).toMatch(/ON CONFLICT \(currency, date\) DO NOTHING/i);
  });
});
