/**
 * A statement closed because its rows are already in the bank ledger still
 * loads its bank-reported balance (2026-11-23).
 *
 * Every bank-feed sync stages a file carrying the account's balance. When one
 * file was approved, the sweep closed the others through finishStatement, which
 * dropped their balances, so an account synced daily only had a balance on the
 * days a file was approved by hand. These pin the shared builder, the
 * fill-only-missing write, and the wiring.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorsFromStagedImport } from "@/lib/bank-ledger-balance";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("anchorsFromStagedImport", () => {
  it("turns the statement balance into an upload_form anchor", () => {
    expect(
      anchorsFromStagedImport({
        parsedAnchors: [],
        statementBalance: 1234.5,
        statementBalanceDate: "2026-11-20",
        statementCurrency: "CAD",
      }),
    ).toEqual([{ date: "2026-11-20", balance: 1234.5, currency: "CAD", source: "upload_form" }]);
  });

  it("keeps valid parsed anchors beside the statement balance", () => {
    const anchors = anchorsFromStagedImport({
      parsedAnchors: [
        { date: "2026-11-18", balance: 10, currency: "CAD", source: "csv_column" },
        { date: "2026-11-19", balance: 5, source: "not_a_source" },
        "junk",
      ],
      statementBalance: 20,
      statementBalanceDate: "2026-11-20",
      statementCurrency: "CAD",
    });
    expect(anchors).toEqual([
      { date: "2026-11-18", balance: 10, currency: "CAD", source: "csv_column" },
      { date: "2026-11-20", balance: 20, currency: "CAD", source: "upload_form" },
    ]);
  });

  it("returns nothing when the statement carries no balance", () => {
    expect(
      anchorsFromStagedImport({
        parsedAnchors: null,
        statementBalance: null,
        statementBalanceDate: null,
        statementCurrency: null,
      }),
    ).toEqual([]);
  });
});

describe("wiring", () => {
  const resolution = read("src/lib/import/statement-resolution.ts");
  const start = resolution.indexOf("export async function finishStatement(");
  const end = resolution.indexOf("export async function finishStatementIfFullyInLedger(");
  const finish = resolution.slice(start, end);

  it("finishStatement loads the statement's balances, filling missing dates only", () => {
    expect(start).toBeGreaterThan(0);
    expect(finish).toContain("anchorsFromStagedImport(staged)");
    expect(finish).toContain("insertMissingBankBalanceAnchors(");
    // Never the overwriting upsert: the closed statement may be older than one
    // already loaded.
    expect(finish).not.toContain("upsertBankBalanceAnchors(");
  });

  it("the fill-only write never overwrites", () => {
    const lib = read("src/lib/bank-ledger-balance.ts");
    const s = lib.indexOf("export async function insertMissingBankBalanceAnchors(");
    const e = lib.indexOf("export async function upsertBankBalanceAnchors(");
    const body = lib.slice(s, e);
    expect(body).toContain(".onConflictDoNothing(");
    expect(body).not.toContain("onConflictDoUpdate");
  });

  it("the approve path builds its anchors with the same function", () => {
    expect(read("src/lib/import/send-to-bank-ledger.ts")).toContain("anchorsFromStagedImport(staged)");
  });

  it("the recovery migration only fills dates that have no balance", () => {
    const sql = read("scripts/migrations/20261123_closed_statement_balances.sql");
    expect(sql).toMatch(/ON CONFLICT \(user_id, account_id, date\) DO NOTHING/);
    expect(sql).not.toMatch(/DO UPDATE/);
  });
});
