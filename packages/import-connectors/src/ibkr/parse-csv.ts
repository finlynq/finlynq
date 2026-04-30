// Parses an Interactive Brokers Activity Statement CSV into IbkrStatement[].
// Activity statements use a "section" layout — every row starts with a
// section name (e.g. "Cash Report", "Trades", "Cash Transactions",
// "Account Information"), then a row kind ("Header" or "Data"), then the
// row's columns. Header rows define the column order for the section's Data
// rows. Sections can repeat for multi-account statements; each Data row
// carries an "Account" column that names the sub-account.
//
// We're intentionally tolerant — IB tweaks header column sets between
// statement settings, so we route by header name rather than column index.
//
// XML is the preferred input (deterministic, no header drift). This CSV path
// is a fallback for users who only have activity-statement output.

import type {
  IbkrCashTransaction,
  IbkrFxTranslation,
  IbkrOpenPosition,
  IbkrParsedFile,
  IbkrStatement,
  IbkrTrade,
} from "./types";
import { parseCsv } from "../wealthposition/csv";

/** A single section's parsed contents — header row + data rows as dicts. */
interface SectionRows {
  /** Each Data row, projected against the most recent Header row's columns. */
  rows: Array<Record<string, string>>;
}

/**
 * Walk the CSV and group `Data` rows by section name. Multiple `Header` rows
 * in the same section restart the column projection — IB sometimes re-emits
 * the header mid-section when it changes the column set.
 */
function groupSections(rows: string[][]): Map<string, SectionRows> {
  const out = new Map<string, SectionRows>();
  let currentSection = "";
  let currentHeaders: string[] = [];

  for (const row of rows) {
    if (row.length < 2) continue;
    const section = row[0]?.trim();
    const kind = row[1]?.trim();
    if (!section || !kind) continue;

    if (kind === "Header") {
      currentSection = section;
      currentHeaders = row.slice(2).map((c) => c.trim());
      if (!out.has(section)) out.set(section, { rows: [] });
      continue;
    }

    if (kind !== "Data") continue;
    if (section !== currentSection) {
      // Data row before its Header — skip.
      continue;
    }

    const dict: Record<string, string> = {};
    const cells = row.slice(2);
    for (let i = 0; i < currentHeaders.length; i++) {
      dict[currentHeaders[i]] = (cells[i] ?? "").trim();
    }
    const bucket = out.get(section)!;
    bucket.rows.push(dict);
  }
  return out;
}

/** "2026-01-05" passes through; "2026-01-05, 12:00:00" → "2026-01-05";
 *  "20260105" → "2026-01-05". */
function normalizeDate(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.split(",")[0].trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  }
  return trimmed;
}

function num(raw: string | undefined): number {
  if (!raw) return 0;
  // IB sometimes wraps negative numbers in parens or uses thousands separators.
  let s = raw.trim();
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/,/g, "");
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

function pickAccount(row: Record<string, string>): string {
  return row.Account || row["Account ID"] || row.AccountId || "";
}

export function parseFlexCsv(text: string): IbkrParsedFile {
  const sections = groupSections(parseCsv(text));

  // 1) Build per-account skeletons from the Account Information section.
  const byAccount = new Map<string, IbkrStatement>();
  const acctInfoRows = sections.get("Account Information")?.rows ?? [];
  for (const r of acctInfoRows) {
    const id = pickAccount(r);
    if (!id) continue;
    if (!byAccount.has(id)) {
      byAccount.set(id, {
        accountId: id,
        accountName: r.Name || r["Account Holder Name"] || id,
        baseCurrency: r.Currency || r["Base Currency"] || "USD",
        cashTransactions: [],
        trades: [],
        openPositions: [],
        fxTranslations: [],
      });
    }
  }

  const ensure = (id: string): IbkrStatement => {
    let s = byAccount.get(id);
    if (!s) {
      s = {
        accountId: id,
        accountName: id,
        baseCurrency: "USD",
        cashTransactions: [],
        trades: [],
        openPositions: [],
        fxTranslations: [],
      };
      byAccount.set(id, s);
    }
    return s;
  };

  // 2) Cash transactions — header set varies, but Account / Currency /
  //    Settle Date / Description / Amount / Type are stable.
  for (const r of sections.get("Cash Transactions")?.rows ?? []) {
    const id = pickAccount(r);
    if (!id) continue;
    const stmt = ensure(id);
    stmt.cashTransactions.push({
      accountId: id,
      date: normalizeDate(r["Settle Date"] || r["Date"] || r["DateTime"]),
      currency: r.Currency || stmt.baseCurrency,
      symbol: r.Symbol || "",
      type: r.Type || r["Activity Type"] || "",
      amount: num(r.Amount),
      description: r.Description || "",
      actionId: r["Action ID"] || r["ActionID"] || undefined,
      tradeId: r["Trade ID"] || r["TradeID"] || undefined,
    });
  }

  // 3) Trades.
  for (const r of sections.get("Trades")?.rows ?? []) {
    const id = pickAccount(r);
    if (!id) continue;
    const stmt = ensure(id);
    const buySell = (r["Code"] || r["Buy/Sell"] || "").toUpperCase();
    const qty = num(r.Quantity);
    stmt.trades.push({
      accountId: id,
      date: normalizeDate(r["Date/Time"] || r["Trade Date"] || r["Date"]),
      currency: r.Currency || stmt.baseCurrency,
      assetCategory: r["Asset Category"] || r.AssetCategory || "STK",
      symbol: r.Symbol || "",
      quantity: qty,
      tradePrice: num(r["T. Price"] || r.TradePrice),
      netCash: num(r["Realized P/L"] === undefined ? r.Proceeds : r.Proceeds || r["Net Cash"]),
      buySell: buySell.includes("SELL") || qty < 0 ? "SELL" : "BUY",
      ibCommission: num(r["Comm/Fee"] || r.Commission),
      tradeId: r["Trade ID"] || r["TradeID"] || undefined,
      description: r.Description || "",
    });
  }

  // 4) Open positions (used for sub-account → Finlynq-account inference).
  for (const r of sections.get("Open Positions")?.rows ?? []) {
    const id = pickAccount(r);
    if (!id) continue;
    const stmt = ensure(id);
    stmt.openPositions.push({
      accountId: id,
      symbol: r.Symbol || "",
      assetCategory: r["Asset Category"] || "STK",
      position: num(r.Quantity || r.Position),
      currency: r.Currency || stmt.baseCurrency,
    });
  }

  // 5) FX P&L translation rows (separate IB section).
  for (const r of sections.get("Forex Income Worksheet")?.rows ?? []) {
    const id = pickAccount(r);
    if (!id) continue;
    const stmt = ensure(id);
    stmt.fxTranslations.push({
      accountId: id,
      date: normalizeDate(r["Date"] || r["Realized Date"]),
      currency: r.Currency || stmt.baseCurrency,
      amount: num(r["Realized P/L"] || r["FX P/L"] || r.Amount),
      description: r.Description || "FX Translation P&L",
    });
  }

  return { statements: Array.from(byAccount.values()) };
}
