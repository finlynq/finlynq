import { describe, it, expect } from "vitest";
import { transformTransactions } from "./transform";
import type {
  ConnectorMappingResolved,
  ExternalAccount,
  ExternalCategory,
  ExternalTransaction,
} from "../types";

// Fixture helpers -----------------------------------------------------------

const wpAccount = (id: string, name: string, type: "A" | "L", currency: string): ExternalAccount => ({
  id,
  name,
  type,
  currency,
  groupName: "Banks",
});

const wpCategory = (id: string, name: string, type: "I" | "E" | "R"): ExternalCategory => ({
  id,
  name,
  type,
  groupName: "Ops",
});

function buildMapping(
  accounts: ExternalAccount[],
  categories: ExternalCategory[],
  opts: { transferCategoryId?: number | null; uncategorizedExternalCategoryIds?: string[] } = {},
) {
  const accountMap = new Map<string, number>();
  const categoryMap = new Map<string, number | null>();
  const accountNameById = new Map<number, string>();
  const categoryNameById = new Map<number, string>();
  const externalAccountById = new Map<string, ExternalAccount>();

  accounts.forEach((a, i) => {
    const pfId = 1000 + i;
    accountMap.set(a.id, pfId);
    accountNameById.set(pfId, a.name);
    externalAccountById.set(a.id, a);
  });

  categories.forEach((c, i) => {
    const pfId = 2000 + i;
    if (opts.uncategorizedExternalCategoryIds?.includes(c.id)) {
      categoryMap.set(c.id, null);
    } else {
      categoryMap.set(c.id, pfId);
      categoryNameById.set(pfId, c.name);
    }
  });

  const explicitTransfer = Object.prototype.hasOwnProperty.call(opts, "transferCategoryId");
  const transferCategoryId = explicitTransfer
    ? (opts.transferCategoryId as number | null)
    : 9999;
  const mapping: ConnectorMappingResolved = {
    accountMap,
    categoryMap,
    transferCategoryId,
    accountNameById,
    categoryNameById,
    externalAccountById,
  };
  if (transferCategoryId !== null) {
    categoryNameById.set(transferCategoryId, "Transfers");
  }

  const byName = {
    externalAccountByName: new Map(accounts.map((a) => [a.name, a.id])),
    externalCategoryByName: new Map(categories.map((c) => [c.name, c.id])),
  };

  return { mapping, byName };
}

// --------------------------------------------------------------------------

describe("transformTransactions", () => {
  const mortgageAccount = wpAccount("acc-1", "Mortage", "L", "CAD");
  const mortgageCategory = wpCategory("cat-1", "Mortgage Interest", "E");

  it("flattens a 1A+1C tx into a single RawTransaction", () => {
    const { mapping, byName } = buildMapping(
      [mortgageAccount],
      [mortgageCategory],
    );
    const tx: ExternalTransaction = {
      id: "tx-1",
      date: "2026-04-01",
      reviewed: false,
      payee: "",
      tags: [],
      entries: [
        { categorization: "Mortage", amount: "-678.13", currency: "CAD", holding: null, note: "principal" },
        { categorization: "Mortgage Interest", amount: "-678.13", currency: "CAD", holding: null, note: "" },
      ],
    };

    const r = transformTransactions([tx], mapping, byName);
    expect(r.errors).toHaveLength(0);
    expect(r.splits).toHaveLength(0);
    expect(r.flat).toHaveLength(1);
    expect(r.flat[0]).toMatchObject({
      date: "2026-04-01",
      account: "Mortage",
      amount: -678.13,
      category: "Mortgage Interest",
      currency: "CAD",
      payee: "principal",
      note: "principal",
    });
    expect(r.flat[0].quantity).toBeUndefined();
  });

  it("emits two RawTransactions for a 2A transfer with a Transfer category", () => {
    const blom = wpAccount("acc-blom", "Blom Business USD", "A", "USD");
    const cash = wpAccount("acc-cash", "Cash USD Lebanon", "A", "USD");
    const { mapping, byName } = buildMapping([blom, cash], []);

    const tx: ExternalTransaction = {
      id: "tx-2",
      date: "2026-04-17",
      reviewed: false,
      payee: "",
      tags: [],
      entries: [
        { categorization: "Blom Business USD", amount: "-1000", currency: "USD", holding: null, note: "" },
        { categorization: "Cash USD Lebanon", amount: "1000", currency: "USD", holding: null, note: "" },
      ],
    };

    const r = transformTransactions([tx], mapping, byName);
    expect(r.errors).toHaveLength(0);
    expect(r.splits).toHaveLength(0);
    expect(r.flat).toHaveLength(2);
    const [a, b] = r.flat;
    expect(a.account).toBe("Blom Business USD");
    expect(a.amount).toBe(-1000);
    expect(a.category).toBe("Transfers");
    expect(a.payee).toContain("Cash USD Lebanon");
    expect(b.account).toBe("Cash USD Lebanon");
    expect(b.amount).toBe(1000);
    expect(b.payee).toContain("Blom Business USD");
  });

  it("errors a transfer when transferCategoryId is not mapped", () => {
    const blom = wpAccount("acc-blom", "Blom Business USD", "A", "USD");
    const cash = wpAccount("acc-cash", "Cash USD Lebanon", "A", "USD");
    const { mapping, byName } = buildMapping(
      [blom, cash],
      [],
      { transferCategoryId: null },
    );

    const tx: ExternalTransaction = {
      id: "tx-2",
      date: "2026-04-17",
      reviewed: false,
      entries: [
        { categorization: "Blom Business USD", amount: "-1000", currency: "USD", holding: null },
        { categorization: "Cash USD Lebanon", amount: "1000", currency: "USD", holding: null },
      ],
    };
    const r = transformTransactions([tx], mapping, byName);
    expect(r.flat).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/Transfer category/);
  });

  it("produces a parent + N split rows for a 1A + multiple-C paycheck", () => {
    const checking = wpAccount("acc-rbc", "RBC Checking", "A", "CAD");
    const wages = wpCategory("cat-wages", "Wages & salary", "I");
    const rrsp = wpCategory("cat-rrsp", "RRSP Contribution", "E");
    const { mapping, byName } = buildMapping([checking], [wages, rrsp]);

    const tx: ExternalTransaction = {
      id: "tx-3",
      date: "2024-10-05",
      reviewed: false,
      payee: "Payroll Deposit HURON ADVISORS",
      tags: [],
      entries: [
        { categorization: "RBC Checking", amount: "3576.56", currency: "CAD", holding: null, note: "Payroll Deposit HURON ADVISORS" },
        { categorization: "Wages & salary", amount: "4119.56", currency: "CAD", holding: null, note: "" },
        { categorization: "RRSP Contribution", amount: "-543.00", currency: "CAD", holding: null, note: "" },
      ],
    };

    const r = transformTransactions([tx], mapping, byName);
    expect(r.errors).toHaveLength(0);
    expect(r.flat).toHaveLength(0);
    expect(r.splits).toHaveLength(1);

    const parent = r.splits[0].parent;
    expect(parent.account).toBe("RBC Checking");
    expect(parent.amount).toBe(3576.56);
    expect(parent.category).toBeUndefined();

    expect(r.splits[0].splits).toHaveLength(2);
    const [s0, s1] = r.splits[0].splits;
    expect(s0.amount).toBe(4119.56);
    expect(s0.categoryId).not.toBeNull();
    expect(s1.amount).toBe(-543);
  });

  it("maps holding to quantity only when holding != amount", () => {
    const btc = wpAccount("acc-btc", "Bitcoin", "A", "CAD");
    const cad = wpCategory("cat-cad", "Crypto purchase", "E");
    const { mapping, byName } = buildMapping([btc], [cad]);

    const tx: ExternalTransaction = {
      id: "tx-4",
      date: "2026-01-15",
      reviewed: false,
      tags: [],
      entries: [
        { categorization: "Bitcoin", amount: "50", currency: "CAD", holding: "0.000311", note: "" },
        { categorization: "Crypto purchase", amount: "50", currency: "CAD", holding: null, note: "" },
      ],
    };
    const r = transformTransactions([tx], mapping, byName);
    expect(r.flat[0].quantity).toBeCloseTo(0.000311, 9);
  });

  it("does NOT set quantity when holding equals amount (cash 1:1)", () => {
    const cad = wpAccount("acc-cad", "CAD WS", "A", "CAD");
    const exp = wpCategory("cat-exp", "Misc", "E");
    const { mapping, byName } = buildMapping([cad], [exp]);

    const tx: ExternalTransaction = {
      id: "tx-5",
      date: "2026-01-15",
      reviewed: false,
      tags: [],
      entries: [
        { categorization: "CAD WS", amount: "-50", currency: "CAD", holding: "-50", note: "" },
        { categorization: "Misc", amount: "-50", currency: "CAD", holding: null, note: "" },
      ],
    };
    const r = transformTransactions([tx], mapping, byName);
    expect(r.flat[0].quantity).toBeUndefined();
  });

  it("handles a 1-entry unconfirmed transaction as flat with no category", () => {
    const checking = wpAccount("acc-rbc", "RBC Checking", "A", "CAD");
    const { mapping, byName } = buildMapping([checking], []);

    const tx: ExternalTransaction = {
      id: "tx-unconfirmed",
      date: "2026-04-20",
      reviewed: false,
      tags: [],
      entries: [
        { categorization: "RBC Checking", amount: "-42.50", currency: "CAD", holding: null, note: "walmart" },
      ],
    };
    const r = transformTransactions([tx], mapping, byName);
    expect(r.errors).toHaveLength(0);
    expect(r.flat).toHaveLength(1);
    expect(r.flat[0].category).toBeUndefined();
    expect(r.flat[0].payee).toBe("walmart");
  });

  it("errors on exotic shapes (2A + 1C)", () => {
    const rbc = wpAccount("acc-rbc", "RBC Checking", "A", "CAD");
    const fid = wpAccount("acc-fid", "Fidelity - CAD", "A", "USD");
    const wages = wpCategory("cat-wages", "Wages & salary", "I");
    const { mapping, byName } = buildMapping([rbc, fid], [wages]);

    const tx: ExternalTransaction = {
      id: "tx-exotic",
      date: "2024-10-05",
      reviewed: false,
      tags: [],
      entries: [
        { categorization: "RBC Checking", amount: "3576.56", currency: "CAD", holding: null, note: "" },
        { categorization: "Wages & salary", amount: "4119.56", currency: "CAD", holding: null, note: "" },
        { categorization: "Fidelity - CAD", amount: "396.39", currency: "USD", holding: "543.00", note: "" },
      ],
    };
    const r = transformTransactions([tx], mapping, byName);
    expect(r.flat).toHaveLength(0);
    expect(r.splits).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].externalId).toBe("tx-exotic");
    expect(r.errors[0].reason).toMatch(/Unsupported shape/);
  });

  it("flags unmapped entries", () => {
    const rbc = wpAccount("acc-rbc", "RBC Checking", "A", "CAD");
    const { mapping, byName } = buildMapping([rbc], []);

    const tx: ExternalTransaction = {
      id: "tx-unmapped",
      date: "2026-04-20",
      reviewed: false,
      tags: [],
      entries: [
        { categorization: "RBC Checking", amount: "-10", currency: "CAD", holding: null, note: "" },
        { categorization: "Some Unmapped Category", amount: "-10", currency: "CAD", holding: null, note: "" },
      ],
    };
    const r = transformTransactions([tx], mapping, byName);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/Unmapped entry/);
  });

  it("serializes tags as comma-separated string", () => {
    const rbc = wpAccount("acc-rbc", "RBC Checking", "A", "CAD");
    const exp = wpCategory("cat-exp", "Misc", "E");
    const { mapping, byName } = buildMapping([rbc], [exp]);

    const tx: ExternalTransaction = {
      id: "tx-tags",
      date: "2026-04-20",
      reviewed: true,
      payee: "Coffee",
      tags: ["morning", "work"],
      entries: [
        { categorization: "RBC Checking", amount: "-5", currency: "CAD", holding: null, note: "" },
        { categorization: "Misc", amount: "-5", currency: "CAD", holding: null, note: "" },
      ],
    };
    const r = transformTransactions([tx], mapping, byName);
    expect(r.flat[0].tags).toBe("morning,work");
    expect(r.flat[0].payee).toBe("Coffee");
  });

  it("preserves a null categoryMap value as uncategorized split row", () => {
    const checking = wpAccount("acc-rbc", "RBC Checking", "A", "CAD");
    const wages = wpCategory("cat-wages", "Wages & salary", "I");
    const other = wpCategory("cat-other", "Unknown Income", "I");
    const { mapping, byName } = buildMapping(
      [checking],
      [wages, other],
      { uncategorizedExternalCategoryIds: ["cat-other"] },
    );

    const tx: ExternalTransaction = {
      id: "tx-nullcat",
      date: "2024-10-05",
      reviewed: false,
      tags: [],
      entries: [
        { categorization: "RBC Checking", amount: "100", currency: "CAD", holding: null, note: "" },
        { categorization: "Wages & salary", amount: "80", currency: "CAD", holding: null, note: "" },
        { categorization: "Unknown Income", amount: "20", currency: "CAD", holding: null, note: "" },
      ],
    };
    const r = transformTransactions([tx], mapping, byName);
    expect(r.errors).toHaveLength(0);
    expect(r.splits).toHaveLength(1);
    const rows = r.splits[0].splits;
    expect(rows).toHaveLength(2);
    expect(rows.some((s) => s.categoryId === null)).toBe(true);
  });
});
