/**
 * Issue #63 — regression tests for the shared CSV parser pipeline.
 *
 * The reconcile route used to skip the auto-template-match and
 * column-mapping fallback steps that the regular /import route had,
 * so any CSV with non-canonical headers (Transaction Date / Description /
 * Debit / Credit etc.) returned "No transactions found in file" 400.
 *
 * These tests pin the pipeline's four-step fallback behavior end-to-end
 * so we don't regress: reconcile and the regular preview now share one
 * implementation in src/lib/external-import/parsers/csv-pipeline.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schemaModule from "@/db/schema-pg";

type TemplateRow = {
  id: number;
  userId: string;
  name: string;
  fileHeaders: string[];
  columnMapping: Record<string, string>;
  defaultAccount: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

const store: { importTemplates: TemplateRow[] } = { importTemplates: [] };

type Cond =
  | { __kind: "eq"; col: unknown; val: unknown }
  | { __kind: "and"; conds: Cond[] };

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __kind: "eq", col, val }) as Cond,
    and: (...conds: Cond[]) => ({ __kind: "and", conds }) as Cond,
  };
});

vi.mock("@/db", () => {
  const schema = schemaModule;

  function matches(row: TemplateRow, where: Cond | undefined): boolean {
    if (!where) return true;
    if (where.__kind === "eq") {
      if (where.col === schema.importTemplates.id) return row.id === where.val;
      if (where.col === schema.importTemplates.userId) return row.userId === where.val;
      return false;
    }
    if (where.__kind === "and") {
      return where.conds.every((c) => matches(row, c));
    }
    return false;
  }

  function selectFromImportTemplates() {
    let pendingWhere: Cond | undefined;
    return {
      from(table: unknown) {
        if (table !== schema.importTemplates) {
          throw new Error("test mock only handles importTemplates");
        }
        return {
          where(c: Cond) {
            pendingWhere = c;
            return this;
          },
          get: async () => store.importTemplates.find((r) => matches(r, pendingWhere)),
          all: async () => store.importTemplates.filter((r) => matches(r, pendingWhere)),
        };
      },
    };
  }

  return {
    db: {
      select: () => selectFromImportTemplates(),
    },
    schema,
  };
});

vi.mock("@/lib/import-templates", async () => {
  const actual = await vi.importActual<typeof import("@/lib/import-templates")>(
    "@/lib/import-templates",
  );
  return {
    ...actual,
    deserializeTemplate: (row: TemplateRow) => ({
      id: row.id,
      userId: row.userId,
      name: row.name,
      fileHeaders: row.fileHeaders,
      columnMapping: row.columnMapping,
      defaultAccount: row.defaultAccount,
      isDefault: row.isDefault,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
  };
});

import {
  buildEmptyCsvError,
  parseCsvWithFallback,
} from "@/lib/external-import/parsers/csv-pipeline";

beforeEach(() => {
  store.importTemplates = [];
});

describe("parseCsvWithFallback — step 2 (canonical headers)", () => {
  it("parses canonical headers without any saved templates", async () => {
    const csv = `Date,Account,Amount,Payee
2024-01-15,Checking,-12.50,Coffee
2024-01-16,Checking,100.00,Salary`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].payee).toBe("Coffee");
    expect(r.rows[1].amount).toBe(100);
    expect(r.appliedTemplateId).toBeUndefined();
  });

  it("strips UTF-8 BOM and still parses canonical headers", async () => {
    const csv = `﻿Date,Account,Amount,Payee
2024-01-15,Checking,-12.50,Coffee`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.rows).toHaveLength(1);
  });

  it("preserves quoted fields containing commas", async () => {
    const csv = `Date,Account,Amount,Payee
2024-01-15,Checking,-12.50,"Coffee, Bagels & More"`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.rows[0].payee).toBe("Coffee, Bagels & More");
  });

  it("fills defaultAccountName on rows whose Account column is empty", async () => {
    const csv = `Date,Account,Amount,Payee
2024-01-15,,-12.50,Coffee`;
    const r = await parseCsvWithFallback({
      text: csv,
      userId: "u1",
      defaultAccountName: "TD Checking",
    });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.rows[0].account).toBe("TD Checking");
  });

  it("does not overwrite an existing Account value with defaultAccountName", async () => {
    const csv = `Date,Account,Amount,Payee
2024-01-15,Savings,-12.50,Coffee`;
    const r = await parseCsvWithFallback({
      text: csv,
      userId: "u1",
      defaultAccountName: "TD Checking",
    });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.rows[0].account).toBe("Savings");
  });
});

describe("parseCsvWithFallback — step 3 (auto-matched template)", () => {
  it("falls through to a saved template when canonical headers don't match", async () => {
    // Non-canonical TD-style headers; canonical step yields zero rows.
    const csv = `Transaction Date,Description,Debit,Credit
2024-01-15,Coffee,12.50,
2024-01-16,Salary,,100.00`;
    store.importTemplates.push({
      id: 1,
      userId: "u1",
      name: "TD Checking",
      fileHeaders: ["Transaction Date", "Description", "Debit", "Credit"],
      columnMapping: {
        date: "Transaction Date",
        amount: "Debit",
        payee: "Description",
      },
      defaultAccount: "TD Checking",
      isDefault: false,
      createdAt: "",
      updatedAt: "",
    });
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.appliedTemplateId).toBe(1);
    expect(r.suggestedTemplate?.score).toBeGreaterThanOrEqual(80);
    // First row has a Debit value, so it parses; second has empty Debit, so
    // it errors. The pipeline returns the row that did parse.
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0].account).toBe("TD Checking");
  });

  it("does NOT match another user's template", async () => {
    const csv = `Transaction Date,Description,Debit,Credit
2024-01-15,Coffee,12.50,`;
    store.importTemplates.push({
      id: 1,
      userId: "other-user",
      name: "TD Checking",
      fileHeaders: ["Transaction Date", "Description", "Debit", "Credit"],
      columnMapping: { date: "Transaction Date", amount: "Debit", payee: "Description" },
      defaultAccount: null,
      isDefault: false,
      createdAt: "",
      updatedAt: "",
    });
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    // u1 has no templates; the other user's template is cross-tenant
    // and ignored. Per the 2026-05-27 Phase 4 fix, step 3.5 now applies
    // auto-detect (Description→payee, Debit→amount) directly so the
    // parse succeeds with no `appliedTemplateId`.
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.appliedTemplateId).toBeUndefined();
    expect(r.rows[0].payee).toBe("Coffee");
  });
});

describe("parseCsvWithFallback — step 3.5 (auto-detect direct apply, 2026-05-27 Phase 4 fix)", () => {
  it("maps Description→payee when canonical headers (Date+Amount) succeed with empty payees", async () => {
    // Reproduces the Phase 4 bug: a CSV with `Date,Description,Amount` used
    // to short-circuit the canonical reader with `payee: ""` on every row.
    // That broke the upload-time rule matcher AND the inbox payee display.
    // The fix: fall through to step 3.5 (auto-detect direct apply) so the
    // synonym `Description` maps to payee end-to-end.
    const csv = `Date,Description,Amount
2026-05-25,Bank interest payment,18.42
2026-05-26,Unknown payee XYZ,-12.34`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].payee).toBe("Bank interest payment");
    expect(r.rows[1].payee).toBe("Unknown payee XYZ");
    expect(r.rows[0].amount).toBe(18.42);
    expect(r.rows[1].amount).toBe(-12.34);
  });

  it("still uses canonical when both Payee column AND Description column are present", async () => {
    // Canonical reader keys on the literal `Payee` column; with one
    // present we should NOT fall through. Description stays as a row
    // field; only Payee drives the matcher.
    const csv = `Date,Description,Amount,Payee
2026-05-25,Random memo,18.42,Bank of America`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.rows[0].payee).toBe("Bank of America");
  });

  it("does not fall through when canonical succeeds and there's nothing payee-mappable", async () => {
    // A CSV with literal Payee column (canonical) — we should NOT
    // re-route through step 3.5 because the rows already have real
    // payees.
    const csv = `Date,Account,Amount,Payee
2024-01-15,Checking,-12.50,Coffee`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.rows[0].payee).toBe("Coffee");
  });
});

describe("parseCsvWithFallback — step 4 (needs-mapping)", () => {
  it("returns parsed via step 3.5 when auto-detect finds date+amount+payee (2026-05-27 fix)", async () => {
    // Pre-Phase-4: this CSV returned `needs-mapping` because no template
    // matched. Post-Phase-4: step 3.5 (auto-detect direct apply) maps
    // Description→payee and Debit→amount, so the parse succeeds without
    // requiring the column-mapping dialog. Auto-detect MUST find a payee
    // for step 3.5 to fire — Description satisfies the synonym list.
    const csv = `Posting Date,Description,Debit,Credit
2024-01-15,Coffee,12.50,
2024-01-16,Salary,,100.00`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.appliedTemplateId).toBeUndefined();
    expect(r.rows[0].payee).toBe("Coffee");
  });

  it("returns needs-mapping with a null suggestedMapping when auto-detect fails", async () => {
    const csv = `Posting Date,Memo,Withdrawal,Deposit
2024-01-15,Coffee,12.50,
2024-01-16,Salary,,100.00`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("needs-mapping");
    if (r.kind !== "needs-mapping") return;
    expect(r.suggestedMapping).toBeNull();
    // Headers and sample rows still surface so the UI can render the dialog.
    expect(r.headers.length).toBe(4);
    expect(r.sampleRows.length).toBe(2);
  });
});

describe("parseCsvWithFallback — step 1 (explicit templateId)", () => {
  it("uses the explicit template even when canonical headers would match", async () => {
    const csv = `Date,Account,Amount,Payee
2024-01-15,Checking,-12.50,Coffee`;
    store.importTemplates.push({
      id: 7,
      userId: "u1",
      name: "Forced",
      fileHeaders: ["Date", "Amount"],
      // Map amount column to Account so we can prove the explicit template ran.
      columnMapping: { date: "Date", amount: "Amount", payee: "Account" },
      defaultAccount: "Forced Account",
      isDefault: false,
      createdAt: "",
      updatedAt: "",
    });
    const r = await parseCsvWithFallback({ text: csv, userId: "u1", templateId: 7 });
    expect(r.kind).toBe("parsed");
    if (r.kind !== "parsed") return;
    expect(r.appliedTemplateId).toBe(7);
    expect(r.rows[0].payee).toBe("Checking"); // proves the template's mapping ran
    expect(r.rows[0].account).toBe("Forced Account");
  });

  it("returns template-not-found for a missing or cross-tenant templateId", async () => {
    const csv = `Date,Amount\n2024-01-15,100`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1", templateId: 999 });
    expect(r.kind).toBe("template-not-found");
  });
});

describe("parseCsvWithFallback — confirmAutoMapping gate (§B, 2026-06-04)", () => {
  it("default (false) keeps canonical headers silent — kind 'parsed'", async () => {
    const csv = `Date,Account,Amount,Payee
2024-01-15,Checking,-12.50,Coffee`;
    const r = await parseCsvWithFallback({ text: csv, userId: "u1" });
    expect(r.kind).toBe("parsed");
  });

  it("confirmAutoMapping gates the canonical-headers step → 'auto-detected'", async () => {
    const csv = `Date,Account,Amount,Payee
2024-01-15,Checking,-12.50,Coffee
2024-01-16,Checking,100.00,Salary`;
    const r = await parseCsvWithFallback({
      text: csv,
      userId: "u1",
      confirmAutoMapping: true,
    });
    expect(r.kind).toBe("auto-detected");
    if (r.kind !== "auto-detected") return;
    expect(r.source).toBe("canonical");
    expect(r.rowCount).toBe(2);
    expect(r.sampleRows.length).toBeGreaterThan(0);
    // Canonical headers map 1:1.
    expect(r.mapping.date).toBe("Date");
    expect(r.mapping.amount).toBe("Amount");
  });

  it("confirmAutoMapping gates the saved-template step → 'auto-detected' w/ templateId", async () => {
    const csv = `Transaction Date,Description,Debit,Credit
2024-01-15,Coffee,12.50,`;
    store.importTemplates.push({
      id: 7,
      userId: "u1",
      name: "TD Checking",
      fileHeaders: ["Transaction Date", "Description", "Debit", "Credit"],
      columnMapping: { date: "Transaction Date", amount: "Debit", payee: "Description" },
      defaultAccount: "TD Checking",
      isDefault: false,
      createdAt: "",
      updatedAt: "",
    });
    const r = await parseCsvWithFallback({
      text: csv,
      userId: "u1",
      confirmAutoMapping: true,
    });
    expect(r.kind).toBe("auto-detected");
    if (r.kind !== "auto-detected") return;
    expect(r.source).toBe("template");
    expect(r.templateId).toBe(7);
  });

  it("confirmAutoMapping gates the auto-detect-direct step → 'auto-detected'", async () => {
    // Non-canonical headers, no saved template → step 3.5 auto-detect drives.
    const csv = `Transaction Date,Description,Amount
2024-01-15,Coffee,-12.50`;
    const r = await parseCsvWithFallback({
      text: csv,
      userId: "u1",
      confirmAutoMapping: true,
    });
    expect(r.kind).toBe("auto-detected");
    if (r.kind !== "auto-detected") return;
    expect(r.source).toBe("auto-detect");
    expect(r.mapping.payee).toBe("Description");
  });

  it("confirmAutoMapping still returns needs-mapping for unmappable files", async () => {
    // No date/amount/payee detectable → step 4 unchanged.
    const csv = `Foo,Bar\nx,y`;
    const r = await parseCsvWithFallback({
      text: csv,
      userId: "u1",
      confirmAutoMapping: true,
    });
    expect(r.kind).toBe("needs-mapping");
  });

  it("an explicit templateId takes the parsed path even with confirmAutoMapping", async () => {
    const csv = `Transaction Date,Description,Debit
2024-01-15,Coffee,12.50`;
    store.importTemplates.push({
      id: 9,
      userId: "u1",
      name: "TD",
      fileHeaders: ["Transaction Date", "Description", "Debit"],
      columnMapping: { date: "Transaction Date", amount: "Debit", payee: "Description" },
      defaultAccount: "TD",
      isDefault: false,
      createdAt: "",
      updatedAt: "",
    });
    const r = await parseCsvWithFallback({
      text: csv,
      userId: "u1",
      templateId: 9,
      confirmAutoMapping: true,
    });
    // Step 1 (explicit template) runs before any confirm gate.
    expect(r.kind).toBe("parsed");
  });
});

describe("buildEmptyCsvError", () => {
  it("includes byte count and first non-empty line", () => {
    const msg = buildEmptyCsvError("Date;Amount;Payee\n2024-01-15;12.50;Coffee");
    expect(msg).toContain("csv");
    expect(msg).toContain("bytes");
    expect(msg).toContain("Date;Amount;Payee");
    expect(msg).toMatch(/semicolons or tabs/);
  });

  it("handles empty input gracefully", () => {
    const msg = buildEmptyCsvError("");
    expect(msg).toContain("file appears empty");
  });

  it("strips a leading BOM before quoting the first line", () => {
    const msg = buildEmptyCsvError("﻿Date,Amount\n");
    expect(msg).toContain("Date,Amount");
  });
});
