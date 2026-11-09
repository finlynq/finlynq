/**
 * MCP record-currency param (2026-11-09, GH #397 follow-up).
 *
 * The account / subscription / holding / cash-sleeve / anchor currency params
 * were a z.enum of the 40-code FX-engine list, so an assistant could not
 * create a UZS account the web app allows. They now accept every reportable
 * currency too, and stay a fully typed string for strict clients (GH #341).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { supportedCurrencyEnum, isAcceptedCurrencyCode } from "../../mcp-server/tools/_shared";

describe("supportedCurrencyEnum (record currency param)", () => {
  it("accepts engine currencies and every reportable currency", () => {
    for (const c of ["USD", "EUR", "CAD", "UZS", "IDR", "KZT", "COP", "BTC", "USDT", "XAU"]) {
      expect(supportedCurrencyEnum.safeParse(c).success, c).toBe(true);
    }
  });

  it("rejects unknown, lower-case and malformed codes", () => {
    for (const c of ["XYZ", "uzs", "US", "USDOLLAR", "", 5]) {
      expect(supportedCurrencyEnum.safeParse(c).success, String(c)).toBe(false);
    }
  });

  it("isAcceptedCurrencyCode agrees with the param", () => {
    expect(isAcceptedCurrencyCode("UZS")).toBe(true);
    expect(isAcceptedCurrencyCode("XYZ")).toBe(false);
  });

  it("renders as a typed string in the JSON schema (no untyped node)", () => {
    const schema = z.toJSONSchema(z.object({ currency: supportedCurrencyEnum.optional() })) as unknown as {
      properties: { currency: { type?: string; pattern?: string } };
    };
    expect(schema.properties.currency.type).toBe("string");
    expect(schema.properties.currency.pattern).toBeTruthy();
  });
});
