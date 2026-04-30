// Provider-internal types for the Interactive Brokers Flex Query connector.
// Mirrors the shape of IB's Flex XML / Activity-statement CSV sections we
// care about. Anything we don't read isn't modeled — keep this lean.
//
// Source-of-truth reference: Interactive Brokers "Flex Web Service Reference"
// (https://www.interactivebrokers.com/en/software/am/am/reports/flexquerysections.htm)
// — public spec, no scraping required to know the field names.

/** One <FlexStatement> block — a single sub-account inside the file. */
export interface IbkrStatement {
  /** IB sub-account id, e.g. "U1234567". The structured format groups
   *  every row under exactly one of these. */
  accountId: string;
  /** Account holder display name (from <AccountInformation name="…">). */
  accountName: string;
  /** Account base currency from <AccountInformation currency="…">. */
  baseCurrency: string;
  /** ISO date (YYYY-MM-DD), opening period boundary. */
  fromDate?: string;
  toDate?: string;
  cashTransactions: IbkrCashTransaction[];
  trades: IbkrTrade[];
  /** Open positions at period end. Used by the orchestrator to build the
   *  sub-account → Finlynq-account mapping by matching held positions. */
  openPositions: IbkrOpenPosition[];
  /** Per-currency translation P&L rows, e.g. an FX revaluation. */
  fxTranslations: IbkrFxTranslation[];
}

/** A single <CashTransaction> row. Covers deposits, withdrawals, dividends,
 *  withholding tax, fees, interest, etc. */
export interface IbkrCashTransaction {
  accountId: string;
  /** ISO date (YYYY-MM-DD). The XML's `dateTime` attr is split. */
  date: string;
  currency: string;
  /** Ticker symbol when the cash event ties to a security (dividends,
   *  withholding tax). Empty string for plain deposits / withdrawals. */
  symbol: string;
  /** Provider-classified type — "Deposits/Withdrawals", "Dividends",
   *  "Withholding Tax", "Broker Interest Received", "Other Fees", etc. */
  type: string;
  /** Signed amount in the row's currency. Positive = credit, negative = debit. */
  amount: number;
  /** Free-text description from the broker. */
  description: string;
  /** Stable id IB assigns to a logical action. A withhold + cancel +
   *  re-issue triplet shares the same actionID — that's the dedup key. */
  actionId?: string;
  /** Trade id when the row references a specific trade settlement. */
  tradeId?: string;
}

/** A single <Trade> row. Covers stock/fund/option buys + sells, plus
 *  forex spot trades (assetCategory="CASH"). */
export interface IbkrTrade {
  accountId: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  currency: string;
  /** "STK" / "FUND" / "OPT" / "BOND" / "CASH" (forex) / "WAR" / "FUT". */
  assetCategory: string;
  /** Ticker for non-CASH; pair like "EUR.USD" for CASH (forex). */
  symbol: string;
  /** Signed share count. Positive = bought / received; negative = sold. */
  quantity: number;
  /** Per-share price in `currency`. Only used for display / sanity. */
  tradePrice: number;
  /** Net cash impact of the trade, including commission, in `currency`. */
  netCash: number;
  /** "BUY" / "SELL" — IB-provided convenience flag. */
  buySell: "BUY" | "SELL";
  /** Negative number representing the IB commission. Already included in
   *  `netCash`; surfaced separately so we can show it as a fee. */
  ibCommission: number;
  /** For forex trades, IB pairs two legs by sharing this id. We use it to
   *  collapse a forex pair into one same-account currency-conversion entry. */
  tradeId?: string;
  /** Free-text description from the broker. */
  description: string;
}

export interface IbkrOpenPosition {
  accountId: string;
  symbol: string;
  assetCategory: string;
  /** Position size at period end. Negative = short. */
  position: number;
  currency: string;
}

export interface IbkrFxTranslation {
  accountId: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  currency: string;
  /** Signed P&L in the row's currency (positive = gain, negative = loss). */
  amount: number;
  description: string;
}

/** Parsed shape returned by both parse-xml and parse-csv. */
export interface IbkrParsedFile {
  statements: IbkrStatement[];
}
