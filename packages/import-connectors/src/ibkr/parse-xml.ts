// Parses an Interactive Brokers Flex Query XML response into IbkrStatement[].
// IB Flex XML is regular: every data element is self-closing with all data on
// attributes. We walk <FlexStatement> blocks, then within each block collect
// all <CashTransaction>, <Trade>, <OpenPosition>, and FX-translation rows.
//
// Hand-rolled to keep the package dependency-free. Robust enough for the
// official format; not a general-purpose XML parser.

import type {
  IbkrCashTransaction,
  IbkrFxTranslation,
  IbkrOpenPosition,
  IbkrParsedFile,
  IbkrStatement,
  IbkrTrade,
} from "./types";

/** Decode the five XML entities Flex actually emits. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Pull `attr="value"` pairs from an opening-tag attribute block. */
export function parseAttributes(attrBlock: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrBlock))) {
    out[m[1]] = decodeEntities(m[2]);
  }
  return out;
}

/** All `<TagName ...>` or `<TagName .../>` openings inside a region. */
export function findElements(
  region: string,
  tagName: string,
): Array<Record<string, string>> {
  const re = new RegExp(`<${tagName}\\b([^>]*)/?>`, "g");
  const out: Array<Record<string, string>> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    out.push(parseAttributes(m[1]));
  }
  return out;
}

/** Find all top-level <FlexStatement>...</FlexStatement> blocks (with their
 *  opening attributes). Doesn't handle nested FlexStatements (IB doesn't
 *  produce them). */
function findFlexStatementRegions(
  xml: string,
): Array<{ attrs: Record<string, string>; region: string }> {
  const out: Array<{ attrs: Record<string, string>; region: string }> = [];
  const openRe = /<FlexStatement\b([^>]*)>/g;
  let openMatch: RegExpExecArray | null;
  while ((openMatch = openRe.exec(xml))) {
    const attrs = parseAttributes(openMatch[1]);
    const start = openMatch.index + openMatch[0].length;
    const closeIdx = xml.indexOf("</FlexStatement>", start);
    if (closeIdx === -1) continue;
    out.push({ attrs, region: xml.slice(start, closeIdx) });
  }
  return out;
}

/** "20260105" or "20260105;120000" → "2026-01-05". */
function isoDate(raw: string | undefined): string {
  if (!raw) return "";
  const datePart = raw.split(";")[0];
  if (datePart.length !== 8) return raw;
  return `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
}

function num(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function isoFromYmd(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return isoDate(raw);
  return raw;
}

export function parseFlexXml(xml: string): IbkrParsedFile {
  const blocks = findFlexStatementRegions(xml);
  const statements: IbkrStatement[] = blocks.map((b) => {
    const accountInfo = findElements(b.region, "AccountInformation")[0] ?? {};
    const accountId =
      b.attrs.accountId ?? accountInfo.accountId ?? accountInfo.acctAlias ?? "";
    const accountName =
      accountInfo.name ?? accountInfo.acctAlias ?? accountId;
    const baseCurrency = accountInfo.currency ?? b.attrs.currency ?? "USD";

    const cashTransactions: IbkrCashTransaction[] = findElements(
      b.region,
      "CashTransaction",
    ).map((a) => ({
      accountId: a.accountId || accountId,
      date: isoDate(a.dateTime || a.settleDate || a.reportDate),
      currency: a.currency || baseCurrency,
      symbol: a.symbol || "",
      type: a.type || "",
      amount: num(a.amount),
      description: a.description || "",
      actionId: a.actionID || a.actionId || undefined,
      tradeId: a.tradeID || a.tradeId || undefined,
    }));

    const trades: IbkrTrade[] = findElements(b.region, "Trade").map((a) => {
      const buySell = (a.buySell || "").toUpperCase() as "BUY" | "SELL";
      return {
        accountId: a.accountId || accountId,
        date: isoDate(a.dateTime || a.tradeDate),
        currency: a.currency || baseCurrency,
        assetCategory: a.assetCategory || "STK",
        symbol: a.symbol || "",
        quantity: num(a.quantity),
        tradePrice: num(a.tradePrice),
        netCash: num(a.netCash),
        buySell: buySell === "SELL" ? "SELL" : "BUY",
        ibCommission: num(a.ibCommission),
        tradeId: a.tradeID || a.tradeId || undefined,
        description: a.description || "",
      };
    });

    const openPositions: IbkrOpenPosition[] = findElements(
      b.region,
      "OpenPosition",
    ).map((a) => ({
      accountId: a.accountId || accountId,
      symbol: a.symbol || "",
      assetCategory: a.assetCategory || "STK",
      position: num(a.position),
      currency: a.currency || baseCurrency,
    }));

    const fxTranslations: IbkrFxTranslation[] = findElements(
      b.region,
      "FxTranslation",
    ).map((a) => ({
      accountId: a.accountId || accountId,
      date: isoDate(a.reportDate || a.date || ""),
      currency: a.currency || baseCurrency,
      amount: num(a.translationPnl ?? a.amount),
      description: a.description || "FX Translation P&L",
    }));

    return {
      accountId,
      accountName,
      baseCurrency,
      fromDate: isoFromYmd(b.attrs.fromDate),
      toDate: isoFromYmd(b.attrs.toDate),
      cashTransactions,
      trades,
      openPositions,
      fxTranslations,
    };
  });

  return { statements };
}
