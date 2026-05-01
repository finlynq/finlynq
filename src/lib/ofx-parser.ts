/**
 * OFX/QFX Parser — manual SGML/XML parsing (no external libraries).
 *
 * OFX (Open Financial Exchange) uses SGML, not strict XML. Tags are often
 * unclosed (e.g. `<DTPOSTED>20240101` without `</DTPOSTED>`). QFX is OFX
 * wrapped with Quicken-specific headers (`<INTU.BID>` etc.).
 *
 * Supports:
 *  - Bank statements (<STMTRS>)
 *  - Credit card statements (<CCSTMTRS>)
 *  - Investment statements (<INVSTMTRS>) — issue #64
 *  - QFX wrapper (stripped automatically; `<INTU.BID>` block stripped)
 *  - SGML form (`OFXHEADER:100`) AND XML form (`<?xml … ?><OFX>…`)
 */

export interface OfxTransaction {
  date: string;       // YYYY-MM-DD
  amount: number;
  payee: string;
  fitId: string;      // Bank-provided unique transaction ID
  type: string;       // DEBIT, CREDIT, CHECK, etc.
  accountType: string; // CHECKING, SAVINGS, CREDITCARD, etc.
  memo: string;
}

export interface OfxAccountInfo {
  bankId: string;
  accountId: string;
  accountType: string;
}

export interface OfxParseResult {
  transactions: OfxTransaction[];
  account: OfxAccountInfo;
  balanceAmount: number | null;
  balanceDate: string | null;
  dateRange: { start: string; end: string } | null;
  currency: string;
}

// ─── Investment-statement shapes (issue #64) ────────────────────────────────

/** Discriminated union over every investment-row kind we recognize. */
export type OfxInvestmentEntry =
  | OfxInvestmentTrade
  | OfxInvestmentIncome
  | OfxInvestmentTransfer;

/** A buy or sell of a security. Position leg + cash leg are emitted by the
 *  canonical-row emitter (`parsers/ofx.ts`) — this struct stays close to the
 *  raw OFX shape so the emitter has everything it needs to pair them. */
export interface OfxInvestmentTrade {
  kind: "trade";
  side: "BUY" | "SELL";
  /** OFX block name: BUYSTOCK / BUYMF / BUYOPT / SELLSTOCK / SELLMF / SELLOPT. */
  blockName: string;
  date: string;            // YYYY-MM-DD (DTTRADE preferred; falls back to DTSETTLE)
  fitId: string;
  /** Signed cash impact on the cash sleeve. OFX `<TOTAL>` is the all-in
   *  amount including commission/fees and is signed (negative for buys). */
  total: number;
  /** Number of shares/units. `<UNITS>` in OFX. Always positive in the file;
   *  the canonical emitter signs it later from `side`. */
  units: number;
  /** Per-unit price. `<UNITPRICE>` in OFX. */
  unitPrice: number;
  /** `<COMMISSION>` — positive in OFX. */
  commission: number;
  /** `<FEES>` — positive in OFX. */
  fees: number;
  /** Currency on the trade. Falls back to the statement's CURDEF. */
  currency: string;
  /** Resolved security: ticker (uppercased) + display name from <SECINFO>. */
  ticker: string;
  secName: string;
  /** Optional <MEMO> attached to the INVTRAN block. */
  memo: string;
}

/** Cash dividend / interest / capital-gain distribution / etc. */
export interface OfxInvestmentIncome {
  kind: "income";
  /** `<INCOMETYPE>` — DIV / INTEREST / CGLONG / CGSHORT / MISC / etc. */
  incomeType: string;
  date: string;
  fitId: string;
  /** `<TOTAL>` — positive credit to the cash sleeve. */
  total: number;
  currency: string;
  /** Often present: dividend on a specific security (otherwise blank). */
  ticker: string;
  secName: string;
  memo: string;
}

/** Cash transfer / journal / fee. We collapse REINVEST + INVBANKTRAN into
 *  this generic shape — the canonical emitter expands REINVEST into an
 *  income + buy pair downstream. */
export interface OfxInvestmentTransfer {
  kind: "transfer";
  /** Sub-type the canonical emitter switches on. */
  subKind: "REINVEST" | "INVBANKTRAN" | "TRANSFER";
  date: string;
  fitId: string;
  /** Signed cash impact on the cash sleeve (positive = credit). */
  total: number;
  /** REINVEST and TRANSFER carry units; INVBANKTRAN doesn't. */
  units: number;
  unitPrice: number;
  currency: string;
  ticker: string;
  secName: string;
  memo: string;
  /** REINVEST only: the income classification carried by `<INCOMETYPE>`. */
  incomeType?: string;
}

export interface OfxInvestmentParseResult {
  /** Brokerage account info (from `<INVACCTFROM>`). */
  account: { brokerId: string; accountId: string };
  /** Reporting currency (CURDEF on the statement). */
  currency: string;
  dateRange: { start: string; end: string } | null;
  entries: OfxInvestmentEntry[];
  /** Securities catalog parsed from `<SECLIST>`. ticker -> display name. */
  securities: Map<string, { ticker: string; name: string; type: string }>;
  /** `<AVAILCASH>` from <INVBAL>, when present. */
  availCash: number | null;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Parse an OFX date string (YYYYMMDD or YYYYMMDDHHMMSS[.XXX:TZ]) to YYYY-MM-DD.
 */
function parseOfxDate(raw: string): string {
  const cleaned = raw.trim().replace(/\[.*$/, ""); // strip timezone bracket
  if (cleaned.length < 8) return "";
  const y = cleaned.slice(0, 4);
  const m = cleaned.slice(4, 6);
  const d = cleaned.slice(6, 8);
  return `${y}-${m}-${d}`;
}

/**
 * Extract the text value of an SGML tag. Handles both:
 *  - Self-closing style:  <TAG>value\n
 *  - Closed style:        <TAG>value</TAG>
 */
function getTagValue(block: string, tag: string): string {
  // Try closed tag first: <TAG>value</TAG>
  const closedRe = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i");
  const closedMatch = block.match(closedRe);
  if (closedMatch) return closedMatch[1].trim();

  // SGML style: <TAG>value (followed by newline or next tag)
  const openRe = new RegExp(`<${tag}>([^<\\n\\r]+)`, "i");
  const openMatch = block.match(openRe);
  if (openMatch) return openMatch[1].trim();

  return "";
}

/**
 * Extract all blocks between <open> and </open> tags.
 */
function extractBlocks(text: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  let match;
  while ((match = re.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

/** Parse a number safely; empty/invalid → 0. */
function num(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a single statement response block (bank or credit card).
 */
function parseStatement(
  block: string,
  accountType: string,
): { transactions: OfxTransaction[]; account: OfxAccountInfo; balance: { amount: number; date: string } | null; currency: string } {
  // Currency
  const currency = getTagValue(block, "CURDEF") || "CAD";

  // Account info
  const bankAcctBlocks = extractBlocks(block, "BANKACCTFROM");
  const ccAcctBlocks = extractBlocks(block, "CCACCTFROM");
  const acctBlock = bankAcctBlocks[0] || ccAcctBlocks[0] || "";

  const account: OfxAccountInfo = {
    bankId: getTagValue(acctBlock, "BANKID"),
    accountId: getTagValue(acctBlock, "ACCTID"),
    accountType: getTagValue(acctBlock, "ACCTTYPE") || accountType,
  };

  // Transactions
  const txnBlocks = extractBlocks(block, "STMTTRN");
  const transactions: OfxTransaction[] = [];

  for (const txn of txnBlocks) {
    const rawDate = getTagValue(txn, "DTPOSTED");
    const rawAmount = getTagValue(txn, "TRNAMT");
    const fitId = getTagValue(txn, "FITID");
    const trnType = getTagValue(txn, "TRNTYPE");
    const name = getTagValue(txn, "NAME");
    const memo = getTagValue(txn, "MEMO");
    const payee = name || memo || "";

    const date = parseOfxDate(rawDate);
    const amount = parseFloat(rawAmount);

    if (!date || isNaN(amount) || !fitId) continue;

    transactions.push({
      date,
      amount,
      payee,
      fitId,
      type: trnType.toUpperCase() || "OTHER",
      accountType: account.accountType || accountType,
      memo: name ? memo : "", // if name was used as payee, keep memo separate
    });
  }

  // Balance
  let balance: { amount: number; date: string } | null = null;
  const ledgerBlocks = extractBlocks(block, "LEDGERBAL");
  if (ledgerBlocks.length > 0) {
    const balAmt = parseFloat(getTagValue(ledgerBlocks[0], "BALAMT"));
    const balDate = parseOfxDate(getTagValue(ledgerBlocks[0], "DTASOF"));
    if (!isNaN(balAmt) && balDate) {
      balance = { amount: balAmt, date: balDate };
    }
  }

  return { transactions, account, balance, currency };
}

/**
 * Strip OFX/QFX SGML headers (everything before the first `<OFX>` tag). Also
 * strips QFX-specific `<INTU.BID>` blocks that some Quicken exports add
 * between the SGML headers and `<OFX>` (or inside the OFX wrapper before the
 * first message-set).
 */
function stripHeaders(raw: string): string {
  let working = raw;
  const idx = working.indexOf("<OFX>");
  if (idx === -1) {
    // Try case-insensitive
    const lower = working.toLowerCase();
    const lowerIdx = lower.indexOf("<ofx>");
    if (lowerIdx !== -1) working = working.slice(lowerIdx);
  } else {
    working = working.slice(idx);
  }

  // QFX exports (Quicken-flavored OFX) often include `<INTU.BID>…</INTU.BID>`
  // and `<INTU.USERID>…` blocks. The SGML reader copes fine but they pollute
  // sub-block extraction (e.g. extractBlocks() pulling INTU children inside
  // an STMTRS scan). Strip them upfront so canonical paths don't see them.
  working = working.replace(/<INTU\.[^>]*>[^<]*(<\/INTU\.[^>]*>)?/gi, "");
  return working;
}

/**
 * Build a SECLIST `ticker -> {name,type}` index. Tickers are uppercased.
 */
function parseSecList(content: string): Map<string, { ticker: string; name: string; type: string }> {
  const out = new Map<string, { ticker: string; name: string; type: string }>();
  const secLists = extractBlocks(content, "SECLIST");
  if (secLists.length === 0) return out;
  for (const list of secLists) {
    // OFX defines STOCKINFO / MFINFO / OPTINFO / DEBTINFO / OTHERINFO. They
    // all wrap a `<SECINFO>` block holding `<SECID><UNIQUEID>…</UNIQUEID>
    // <UNIQUEIDTYPE>…` and `<SECNAME>` + `<TICKER>`.
    const infoTags = ["STOCKINFO", "MFINFO", "OPTINFO", "DEBTINFO", "OTHERINFO"];
    for (const tag of infoTags) {
      const blocks = extractBlocks(list, tag);
      for (const b of blocks) {
        const ticker = (getTagValue(b, "TICKER") || "").toUpperCase().trim();
        const name = getTagValue(b, "SECNAME") || "";
        const type = tag.replace("INFO", "");
        if (ticker) {
          out.set(ticker, { ticker, name, type });
        }
      }
    }
  }
  return out;
}

/** Read a single trade block (BUYSTOCK / SELLSTOCK / BUYMF / …) into a
 *  canonical `OfxInvestmentTrade`. Returns null when the block is missing
 *  the load-bearing fields (date / fitId / units). */
function parseTrade(
  block: string,
  blockName: string,
  side: "BUY" | "SELL",
  defaultCurrency: string,
  secList: Map<string, { ticker: string; name: string; type: string }>,
): OfxInvestmentTrade | null {
  const invtran = extractBlocks(block, "INVTRAN")[0] ?? "";
  const fitId = getTagValue(invtran, "FITID");
  const dtTrade = parseOfxDate(getTagValue(invtran, "DTTRADE"));
  const dtSettle = parseOfxDate(getTagValue(invtran, "DTSETTLE"));
  const date = dtTrade || dtSettle;
  if (!date || !fitId) return null;

  // Security id — most exports use the ticker directly in `<UNIQUEID>` with
  // `UNIQUEIDTYPE=TICKER`, but CUSIP exports also exist. We index SECLIST by
  // ticker; for CUSIP-only files the ticker stays empty and the canonical
  // emitter falls back to the security name.
  const secId = extractBlocks(block, "SECID")[0] ?? "";
  const uniqueId = (getTagValue(secId, "UNIQUEID") || "").trim();
  const idType = (getTagValue(secId, "UNIQUEIDTYPE") || "").toUpperCase();

  let ticker = "";
  let secName = "";
  if (idType === "TICKER" && uniqueId) {
    ticker = uniqueId.toUpperCase();
  }
  // SECLIST hit fills in the display name even when ticker came from the
  // INVBUY/INVSELL block directly via TICKER (some brokers stamp the ticker
  // on the trade itself, redundant with SECID).
  if (!ticker) {
    const direct = (getTagValue(block, "TICKER") || "").toUpperCase().trim();
    if (direct) ticker = direct;
  }
  if (ticker && secList.has(ticker)) {
    secName = secList.get(ticker)!.name;
  }
  // Stay empty when SECLIST didn't supply a name AND the trade block doesn't
  // carry one inline. The caller (`parseOfxInvestments`) post-fills from a
  // file-level SECLIST after the per-statement parse runs, then the
  // canonical emitter falls back to the ticker. Filling with the ticker
  // here would short-circuit that post-fill.
  if (!secName) {
    secName = getTagValue(block, "SECNAME") || "";
  }

  return {
    kind: "trade",
    side,
    blockName,
    date,
    fitId,
    total: num(getTagValue(block, "TOTAL")),
    units: Math.abs(num(getTagValue(block, "UNITS"))),
    unitPrice: num(getTagValue(block, "UNITPRICE")),
    commission: num(getTagValue(block, "COMMISSION")),
    fees: num(getTagValue(block, "FEES")),
    currency: getTagValue(block, "CURSYM") || defaultCurrency,
    ticker,
    secName,
    memo: getTagValue(invtran, "MEMO"),
  };
}

/** Read an `<INCOME>` block into a canonical income entry. */
function parseIncome(
  block: string,
  defaultCurrency: string,
  secList: Map<string, { ticker: string; name: string; type: string }>,
): OfxInvestmentIncome | null {
  const invtran = extractBlocks(block, "INVTRAN")[0] ?? "";
  const fitId = getTagValue(invtran, "FITID");
  const date = parseOfxDate(getTagValue(invtran, "DTTRADE")) ||
    parseOfxDate(getTagValue(invtran, "DTSETTLE"));
  if (!date || !fitId) return null;

  const secId = extractBlocks(block, "SECID")[0] ?? "";
  const uniqueId = (getTagValue(secId, "UNIQUEID") || "").trim();
  const idType = (getTagValue(secId, "UNIQUEIDTYPE") || "").toUpperCase();
  const ticker = idType === "TICKER" && uniqueId ? uniqueId.toUpperCase() : "";
  const secName = ticker && secList.has(ticker) ? secList.get(ticker)!.name : "";

  return {
    kind: "income",
    incomeType: (getTagValue(block, "INCOMETYPE") || "MISC").toUpperCase(),
    date,
    fitId,
    total: num(getTagValue(block, "TOTAL")),
    currency: getTagValue(block, "CURSYM") || defaultCurrency,
    ticker,
    secName,
    memo: getTagValue(invtran, "MEMO"),
  };
}

/** Read a REINVEST / INVBANKTRAN / TRANSFER block. */
function parseTransfer(
  block: string,
  subKind: "REINVEST" | "INVBANKTRAN" | "TRANSFER",
  defaultCurrency: string,
  secList: Map<string, { ticker: string; name: string; type: string }>,
): OfxInvestmentTransfer | null {
  // INVBANKTRAN wraps STMTTRN — handle that one specially.
  if (subKind === "INVBANKTRAN") {
    const stmt = extractBlocks(block, "STMTTRN")[0] ?? "";
    const fitId = getTagValue(stmt, "FITID");
    const date = parseOfxDate(getTagValue(stmt, "DTPOSTED"));
    if (!date || !fitId) return null;
    return {
      kind: "transfer",
      subKind,
      date,
      fitId,
      total: num(getTagValue(stmt, "TRNAMT")),
      units: 0,
      unitPrice: 0,
      currency: getTagValue(block, "SUBACCTFUND") ? defaultCurrency : defaultCurrency,
      ticker: "",
      secName: "",
      memo: getTagValue(stmt, "NAME") || getTagValue(stmt, "MEMO") || "",
    };
  }

  const invtran = extractBlocks(block, "INVTRAN")[0] ?? "";
  const fitId = getTagValue(invtran, "FITID");
  const date = parseOfxDate(getTagValue(invtran, "DTTRADE")) ||
    parseOfxDate(getTagValue(invtran, "DTSETTLE"));
  if (!date || !fitId) return null;

  const secId = extractBlocks(block, "SECID")[0] ?? "";
  const uniqueId = (getTagValue(secId, "UNIQUEID") || "").trim();
  const idType = (getTagValue(secId, "UNIQUEIDTYPE") || "").toUpperCase();
  const ticker = idType === "TICKER" && uniqueId ? uniqueId.toUpperCase() : "";
  const secName = ticker && secList.has(ticker) ? secList.get(ticker)!.name : "";

  const incomeType = subKind === "REINVEST"
    ? (getTagValue(block, "INCOMETYPE") || "DIV").toUpperCase()
    : undefined;

  return {
    kind: "transfer",
    subKind,
    date,
    fitId,
    total: num(getTagValue(block, "TOTAL")),
    units: Math.abs(num(getTagValue(block, "UNITS"))),
    unitPrice: num(getTagValue(block, "UNITPRICE")),
    currency: getTagValue(block, "CURSYM") || defaultCurrency,
    ticker,
    secName,
    memo: getTagValue(invtran, "MEMO"),
    incomeType,
  };
}

/** Parse a single `<INVSTMTRS>` block into a canonical result. */
function parseInvestmentStatement(
  block: string,
): OfxInvestmentParseResult {
  const currency = getTagValue(block, "CURDEF") || "USD";

  // Account
  const acctBlock = extractBlocks(block, "INVACCTFROM")[0] ?? "";
  const account = {
    brokerId: getTagValue(acctBlock, "BROKERID"),
    accountId: getTagValue(acctBlock, "ACCTID"),
  };

  // Transactions
  const tranList = extractBlocks(block, "INVTRANLIST")[0] ?? "";
  const dtStart = parseOfxDate(getTagValue(tranList, "DTSTART"));
  const dtEnd = parseOfxDate(getTagValue(tranList, "DTEND"));

  // SECLIST is a sibling of INVSTMTRS at the OFX root, not inside the
  // statement — the caller (parseInvestments) plumbs it in via secList. We
  // rebuild an empty-by-default fallback here so the helpers stay pure.
  const emptySec = new Map<string, { ticker: string; name: string; type: string }>();

  const entries: OfxInvestmentEntry[] = [];

  // BUY blocks
  for (const [name, side] of [
    ["BUYSTOCK", "BUY"],
    ["BUYMF", "BUY"],
    ["BUYOPT", "BUY"],
    ["BUYOTHER", "BUY"],
    ["BUYDEBT", "BUY"],
    ["SELLSTOCK", "SELL"],
    ["SELLMF", "SELL"],
    ["SELLOPT", "SELL"],
    ["SELLOTHER", "SELL"],
    ["SELLDEBT", "SELL"],
  ] as const) {
    const blocks = extractBlocks(tranList, name);
    for (const b of blocks) {
      const trade = parseTrade(b, name, side, currency, emptySec);
      if (trade) entries.push(trade);
    }
  }

  for (const b of extractBlocks(tranList, "INCOME")) {
    const inc = parseIncome(b, currency, emptySec);
    if (inc) entries.push(inc);
  }

  for (const b of extractBlocks(tranList, "REINVEST")) {
    const t = parseTransfer(b, "REINVEST", currency, emptySec);
    if (t) entries.push(t);
  }

  for (const b of extractBlocks(tranList, "INVBANKTRAN")) {
    const t = parseTransfer(b, "INVBANKTRAN", currency, emptySec);
    if (t) entries.push(t);
  }

  for (const b of extractBlocks(tranList, "TRANSFER")) {
    const t = parseTransfer(b, "TRANSFER", currency, emptySec);
    if (t) entries.push(t);
  }

  // Available cash (optional — some brokers only emit positions, not balance).
  let availCash: number | null = null;
  const invBalBlock = extractBlocks(block, "INVBAL")[0] ?? "";
  if (invBalBlock) {
    const raw = getTagValue(invBalBlock, "AVAILCASH");
    if (raw !== "") {
      const v = parseFloat(raw);
      if (Number.isFinite(v)) availCash = v;
    }
  }

  const dateRange = dtStart && dtEnd ? { start: dtStart, end: dtEnd } : null;

  return {
    account,
    currency,
    dateRange,
    entries,
    securities: emptySec,
    availCash,
  };
}

/**
 * Main entry point: parse an OFX or QFX file content string. Detects bank,
 * credit-card, and investment statements; bank/CC statements come back via
 * `transactions[]` for backward compatibility. Investment statements use
 * `parseOfxInvestments()` instead — they're a different shape entirely.
 */
export function parseOfx(raw: string): OfxParseResult {
  const content = stripHeaders(raw);

  // Try bank statements first
  let stmtBlocks = extractBlocks(content, "STMTRS");
  let accountType = "CHECKING";

  // Try credit card statements
  if (stmtBlocks.length === 0) {
    stmtBlocks = extractBlocks(content, "CCSTMTRS");
    accountType = "CREDITCARD";
  }

  if (stmtBlocks.length === 0) {
    return {
      transactions: [],
      account: { bankId: "", accountId: "", accountType: "" },
      balanceAmount: null,
      balanceDate: null,
      dateRange: null,
      currency: "CAD",
    };
  }

  // Parse the first statement block
  const result = parseStatement(stmtBlocks[0], accountType);

  // If multiple statement blocks, merge transactions
  for (let i = 1; i < stmtBlocks.length; i++) {
    const extra = parseStatement(stmtBlocks[i], accountType);
    result.transactions.push(...extra.transactions);
  }

  // Sort transactions by date
  result.transactions.sort((a, b) => a.date.localeCompare(b.date));

  // Compute date range
  let dateRange: { start: string; end: string } | null = null;
  if (result.transactions.length > 0) {
    dateRange = {
      start: result.transactions[0].date,
      end: result.transactions[result.transactions.length - 1].date,
    };
  }

  return {
    transactions: result.transactions,
    account: result.account,
    balanceAmount: result.balance?.amount ?? null,
    balanceDate: result.balance?.date ?? null,
    dateRange,
    currency: result.currency,
  };
}

/**
 * Parse the investment-statement portion of an OFX/QFX file. Returns one
 * `OfxInvestmentParseResult` per `<INVSTMTRS>` block (typically one per
 * brokerage account in the file).
 */
export function parseOfxInvestments(raw: string): OfxInvestmentParseResult[] {
  const content = stripHeaders(raw);
  const stmtBlocks = extractBlocks(content, "INVSTMTRS");
  if (stmtBlocks.length === 0) return [];

  // SECLIST is at the OFX root, shared by every INVSTMTRS in the file.
  const secList = parseSecList(content);

  return stmtBlocks.map((block) => {
    const parsed = parseInvestmentStatement(block);
    // Fill in security display names from the file-level SECLIST.
    if (secList.size > 0) {
      for (const e of parsed.entries) {
        if (e.kind === "income" || e.kind === "trade" || e.kind === "transfer") {
          if (e.ticker && !e.secName && secList.has(e.ticker)) {
            e.secName = secList.get(e.ticker)!.name;
          }
        }
      }
      parsed.securities = secList;
    }
    return parsed;
  });
}

/** True if the file contains any investment-statement block. Cheap pre-check
 *  callers use to decide whether to dispatch to the investment parser. */
export function hasInvestmentStatement(raw: string): boolean {
  return /<INVSTMTRS\b/i.test(raw);
}
