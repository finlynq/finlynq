/**
 * Pure-unit tests for the per-symbol earliest-available-date memo — the
 * snapshot-rebuild "pre-inception storm" fix. A symbol has no provider data
 * before its inception/listing date (e.g. AAVE-USD → 2020-10-02); a rebuild
 * walking OLDEST-first otherwise re-fetches the symbol's full history once per
 * pre-inception day and saves nothing. `noteEarliestDataDate` records the proven
 * first-data date and `isBeforeEarliestData` short-circuits earlier requests.
 *
 * `@/db` is stubbed so importing price-service.ts never touches Postgres; the
 * memo is a pure in-memory Map (no DB, no clock). Each test uses a UNIQUE symbol
 * because the memo is module-level state shared across the file.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/db", () => ({ db: {}, schema: { priceCache: {} } }));

import { isBeforeEarliestData, noteEarliestDataDate } from "@/lib/price-service";

describe("earliest-available-data memo", () => {
  it("returns false for a symbol we've learned nothing about", () => {
    expect(isBeforeEarliestData("UNSEEN-USD", "2019-01-01")).toBe(false);
  });

  it("short-circuits dates strictly before the recorded inception", () => {
    noteEarliestDataDate("AAVE-USD", "2020-10-02");
    // Pre-inception walk days → skip the doomed fetch.
    expect(isBeforeEarliestData("AAVE-USD", "2020-01-01")).toBe(true);
    expect(isBeforeEarliestData("AAVE-USD", "2020-10-01")).toBe(true);
    // The inception date itself and anything after → real data exists, fetch.
    expect(isBeforeEarliestData("AAVE-USD", "2020-10-02")).toBe(false);
    expect(isBeforeEarliestData("AAVE-USD", "2021-06-01")).toBe(false);
  });

  it("keeps the EARLIEST observation (a later note never masks proven-good dates)", () => {
    noteEarliestDataDate("CRV-USD", "2020-08-14");
    // A looser/later observation must NOT push the boundary forward.
    noteEarliestDataDate("CRV-USD", "2021-01-01");
    expect(isBeforeEarliestData("CRV-USD", "2020-09-01")).toBe(false); // still has data
    expect(isBeforeEarliestData("CRV-USD", "2020-08-13")).toBe(true);
    // An EARLIER observation does tighten it (defensive; shouldn't normally happen).
    noteEarliestDataDate("CRV-USD", "2020-07-01");
    expect(isBeforeEarliestData("CRV-USD", "2020-07-15")).toBe(false);
    expect(isBeforeEarliestData("CRV-USD", "2020-06-30")).toBe(true);
  });
});
