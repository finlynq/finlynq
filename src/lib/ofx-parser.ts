/**
 * OFX/QFX Parser — manual SGML/XML parsing (no external libraries).
 *
 * OFX (Open Financial Exchange) uses SGML, not strict XML. Tags are often
 * unclosed (e.g. `<DTPOSTED>20240101` without `</DTPOSTED>`). QFX is OFX
 * wrapped with Quicken-specific headers.
 *
 * Supports:
 *  - Bank statements (<STMTRS>)
 *  - Credit card statements (<CCSTMTRS>)
 *  - QFX wrapper (stripped automatically)
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
 * Strip OFX/QFX SGML headers (everything before the first `<OFX>` tag).
 */
function stripHeaders(raw: string): string {
  const idx = raw.indexOf("<OFX>");
  if (idx === -1) {
    // Try case-insensitive
    const lower = raw.toLowerCase();
    const lowerIdx = lower.indexOf("<ofx>");
    if (lowerIdx === -1) return raw;
    return raw.slice(lowerIdx);
  }
  return raw.slice(idx);
}

/**
 * Main entry point: parse an OFX or QFX file content string.
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
