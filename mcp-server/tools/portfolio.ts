/**
 * MCP HTTP tool group: portfolio (FINLYNQ-109 extraction).
 *
 * Handler bodies moved VERBATIM out of register-tools-pg.ts. The only edits
 * are the enclosing function wrapper + the shared-state destructure from ctx.
 * Do not reformat or re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  text,
  err,
  dataResponse,
  suggestionList,
  fuzzyFind,
  resolveAccountStrict,
  resolvePortfolioHoldingStrict,
  decryptNameish,
  resolvePortfolioHoldingByName,
  supportedCurrencyEnum,
  PORTFOLIO_DISCLAIMER,
  type Row,
  type AccountResolveResult,
  type PgToolContext,
} from "./_shared";
import { aggregateHoldings } from "../../src/lib/portfolio/aggregate-holdings";
import { getHoldingsValueByHolding } from "../../src/lib/holdings-value";
import {
  sql,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  decryptField,
} from "../../src/lib/crypto/envelope";
import {
  encryptName,
  nameLookup,
} from "../../src/lib/crypto/encrypted-columns";
import {
  resolveDividendsCategoryId,
} from "../../src/lib/dividends-category";
import {
  resolveOrCreateSecurity,
  gcOrphanSecurity,
} from "../../src/lib/securities/resolve";
import {
  resolveOrCreateInvestmentIncomeCategory,
} from "../../src/lib/investment-income-category";
import {
  getRate,
} from "../../src/lib/fx-service";
import {
} from "../../src/lib/fx/supported-currencies";
import {
  roundMoney,
} from "../../src/lib/money";
import {
  recordBuy,
  recordSell,
  recordSwap,
  recordInKindTransfer,
  recordPortfolioIncomeOrExpense,
  recordFxConversion,
  recordBrokerageDeposit,
  recordBrokerageWithdrawal,
  CashSleeveNotFoundError,
  CurrencyMismatchError,
  HoldingNotFoundError,
  InvalidLinkPairError,
} from "../../src/lib/portfolio/operations";
import {
  resolveReportingCurrency,
} from "../reporting-currency";
import {
  tagAmount,
} from "../currency-tagging";
import {
  invalidateUser as invalidateUserTxCache,
} from "../../src/lib/mcp/user-tx-cache";
import {
  markSnapshotsDirty,
} from "../../src/lib/portfolio/snapshots/dirty";
import {
  ymdDate,
} from "../lib/date-validators";

export function registerPortfolioTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek, encNote } = ctx;


  // ── portfolio_* operation tools (canonical portfolio writes) ────────────────
  // Thin MCP wrappers over src/lib/portfolio/operations.ts — the SAME domain
  // helpers the web forms + mobile drive through /api/portfolio/operations/*.
  // They write the canonical lot-aware, sign-correct rows (stock leg +, cash
  // leg −, sum 0; *_cash_leg / fx_* / brokerage_* kinds) that record_transaction
  // can't. HTTP transport only — they encrypt payee/note and need an unlocked
  // DEK (stdio has none). CREATE-ONLY: edits stay on the web/REST path (the
  // edit-as-replace cascade is NextResponse-coupled). Account resolves by name
  // (strict fuzzy) OR exact id; holdings the same, scoped to the resolved
  // account. Domain errors map to friendly tool errors (mirrors mapOperationError).
  type PortfolioAcctResolve = { ok: true; acct: Row } | { ok: false; error: string };
  const loadOpAccounts = async (): Promise<Row[]> =>
    decryptNameish(
      await q(db, sql`SELECT id, currency, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}`),
      dek,
    );
  const resolveOpAccount = (
    label: string,
    name: string | undefined,
    id: number | undefined,
    accounts: Row[],
  ): PortfolioAcctResolve => {
    const resolveErr = (r: Extract<AccountResolveResult, { ok: false }>): string => {
      const suggestions = suggestionList(name ?? "", accounts);
      if (r.reason === "ambiguous") return `Ambiguous ${label}: "${name}" matches ${r.candidates.length} accounts. Did you mean: ${suggestions}? (Pass the id to disambiguate.)`;
      if (r.reason === "low_confidence") return `${label} "${name}" did not match strongly — closest is "${r.suggestion.name}". Did you mean: ${suggestions}? (Pass the id to disambiguate.)`;
      return `${label} "${name}" not found. Did you mean: ${suggestions}?`;
    };
    if (name != null && id != null) {
      const r = resolveAccountStrict(name, accounts);
      if (!r.ok) return { ok: false, error: resolveErr(r) };
      if (Number(r.account.id) !== id) return { ok: false, error: `${label} mismatch: "${name}" resolved to #${Number(r.account.id)}, but id=${id} was passed. Pass only one, or make them agree.` };
      return { ok: true, acct: r.account };
    }
    if (id != null) {
      const a = accounts.find((x) => Number(x.id) === id) ?? null;
      if (!a) return { ok: false, error: `${label} #${id} not found or not owned by you.` };
      return { ok: true, acct: a };
    }
    if (!name) return { ok: false, error: `Pass either ${label} name or id.` };
    const r = resolveAccountStrict(name, accounts);
    if (!r.ok) return { ok: false, error: resolveErr(r) };
    return { ok: true, acct: r.account };
  };
  const resolveOpHolding = async (
    label: string,
    accountId: number,
    name: string | undefined,
    id: number | undefined,
  ): Promise<{ ok: true; id: number } | { ok: false; error: string }> => {
    if (name != null) {
      const r = await resolvePortfolioHoldingByName(db, userId, name, dek, accountId);
      if (!r.ok) return { ok: false, error: r.error };
      if (id != null && id !== r.id) return { ok: false, error: `${label} "${name}" resolves to #${r.id}, but id=${id} disagrees. Pass only one, or make them match.` };
      return { ok: true, id: r.id };
    }
    if (id != null) {
      const owns = await q(db, sql`SELECT 1 AS ok FROM portfolio_holdings WHERE id = ${id} AND user_id = ${userId} AND account_id = ${accountId}`);
      if (!owns.length) return { ok: false, error: `${label} #${id} not found in the resolved account (or not owned by you).` };
      return { ok: true, id };
    }
    return { ok: false, error: `Pass either ${label} name or id.` };
  };
  const mapPortfolioOpError = (e: unknown): string | null => {
    if (
      e instanceof CashSleeveNotFoundError ||
      e instanceof CurrencyMismatchError ||
      e instanceof HoldingNotFoundError ||
      e instanceof InvalidLinkPairError
    ) {
      return e.message;
    }
    // operations.ts also throws plain Errors for guard violations (qty<=0,
    // same source/dest account, cash-sleeve passed to in-kind, etc.). Surface
    // the message rather than letting it escape as a 500.
    if (e instanceof Error && /^record(Buy|Sell|Swap|InKindTransfer|PortfolioIncomeOrExpense|FxConversion|Brokerage)/.test(e.message)) {
      return e.message;
    }
    return null;
  };
  const today = () => new Date().toISOString().split("T")[0];

  server.tool(
    "portfolio_buy",
    "Buy shares/units of a holding in a brokerage account. Writes the canonical buy + buy_cash_leg pair (stock leg positive, cash leg negative, sum 0), opens a cost-basis lot, and debits the cash sleeve for the holding's currency — that sleeve must already exist (add_portfolio_holding a 'Cash' holding for the currency first if missing). Resolve the account by `account` name (strict fuzzy) or exact `account_id`, and the position by `holding` name/ticker or exact `holdingId`. CREATE-ONLY (edit on the web). Replaces the removed record_trade buy path.",
    {
      account: z.string().optional().describe("Brokerage account name or alias (strict fuzzy). Pass this or account_id."),
      account_id: z.number().int().optional().describe("Brokerage account id (exact; wins over name)."),
      holding: z.string().optional().describe("Holding name or ticker to buy (must already exist in the account). Pass this or holdingId."),
      holdingId: z.number().int().optional().describe("portfolio_holdings.id of the position (exact)."),
      qty: z.number().positive().describe("Units acquired (> 0)."),
      totalCost: z.number().positive().describe("Total cost in the holding's currency (> 0)."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)."),
      payee: z.string().optional(),
      note: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated tags."),
      cashSleeveHoldingId: z.number().int().optional().describe("Explicit cash sleeve to debit; defaults to the (account, holding-currency) sleeve."),
    },
    async ({ account, account_id, holding, holdingId, qty, totalCost, date, payee, note, tags, cashSleeveHoldingId }) => {
      if (!dek) return err("portfolio_buy requires an active session DEK — log in again to encrypt the rows.");
      const accounts = await loadOpAccounts();
      const a = resolveOpAccount("account", account, account_id, accounts);
      if (!a.ok) return err(a.error);
      const h = await resolveOpHolding("holding", Number(a.acct.id), holding, holdingId);
      if (!h.ok) return err(h.error);
      const txDate = date ?? today();
      try {
        const result = await recordBuy({ userId, dek, accountId: Number(a.acct.id), holdingId: h.id, qty, totalCost, date: txDate, payee, note, tags, cashSleeveHoldingId, source: "mcp_http" });
        invalidateUserTxCache(userId);
        await markSnapshotsDirty(userId, txDate);
        return text({ success: true, data: { ...result, resolvedAccount: { id: Number(a.acct.id), name: String(a.acct.name ?? "") }, message: `Bought ${qty} × holding #${h.id} for ${totalCost} on ${txDate} in ${a.acct.name}.` } });
      } catch (e) {
        const m = mapPortfolioOpError(e);
        if (m) return err(m);
        throw e;
      }
    }
  );


  server.tool(
    "portfolio_sell",
    "Sell shares/units of a holding in a brokerage account. Writes sell + sell_cash_leg (stock leg negative, cash leg positive, sum 0), closes cost-basis lots, and credits the cash sleeve. `lotSelection.method` is FIFO (default), HIFO, or SPECIFIC (SPECIFIC needs lotIds or per-lot lots[]). CREATE-ONLY. Replaces the removed record_trade sell path.",
    {
      account: z.string().optional().describe("Brokerage account name or alias. Pass this or account_id."),
      account_id: z.number().int().optional().describe("Brokerage account id (exact; wins over name)."),
      holding: z.string().optional().describe("Holding name or ticker to sell (must already exist). Pass this or holdingId."),
      holdingId: z.number().int().optional().describe("portfolio_holdings.id of the position (exact)."),
      qty: z.number().positive().describe("Units sold (> 0)."),
      totalProceeds: z.number().positive().describe("Total proceeds in the holding's currency (> 0)."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)."),
      lotSelection: z
        .object({
          method: z.enum(["FIFO", "HIFO", "SPECIFIC"]),
          lotIds: z.array(z.number().int().positive()).optional(),
          lots: z.array(z.object({ lotId: z.number().int().positive(), qty: z.number().positive() })).optional(),
        })
        .optional()
        .describe("Lot disposal strategy (default FIFO). SPECIFIC requires lotIds or per-lot lots."),
      payee: z.string().optional(),
      note: z.string().optional(),
      tags: z.string().optional(),
      cashSleeveHoldingId: z.number().int().optional().describe("Explicit cash sleeve to credit; defaults to the (account, holding-currency) sleeve."),
    },
    async ({ account, account_id, holding, holdingId, qty, totalProceeds, date, lotSelection, payee, note, tags, cashSleeveHoldingId }) => {
      if (!dek) return err("portfolio_sell requires an active session DEK — log in again to encrypt the rows.");
      const accounts = await loadOpAccounts();
      const a = resolveOpAccount("account", account, account_id, accounts);
      if (!a.ok) return err(a.error);
      const h = await resolveOpHolding("holding", Number(a.acct.id), holding, holdingId);
      if (!h.ok) return err(h.error);
      const txDate = date ?? today();
      try {
        const result = await recordSell({ userId, dek, accountId: Number(a.acct.id), holdingId: h.id, qty, totalProceeds, date: txDate, lotSelection, payee, note, tags, cashSleeveHoldingId, source: "mcp_http" });
        invalidateUserTxCache(userId);
        await markSnapshotsDirty(userId, txDate);
        return text({ success: true, data: { ...result, resolvedAccount: { id: Number(a.acct.id), name: String(a.acct.name ?? "") }, message: `Sold ${qty} × holding #${h.id} for ${totalProceeds} on ${txDate} in ${a.acct.name}.` } });
      } catch (e) {
        const m = mapPortfolioOpError(e);
        if (m) return err(m);
        throw e;
      }
    }
  );


  server.tool(
    "portfolio_swap",
    "Swap one holding for another inside a SINGLE brokerage account in one atomic operation. Runs an internal sell of the source + buy of the destination, sharing a swap_link_id. Both holdings must already exist in the account. CREATE-ONLY.",
    {
      account: z.string().optional().describe("Brokerage account name or alias. Pass this or account_id."),
      account_id: z.number().int().optional().describe("Brokerage account id (exact; wins over name)."),
      sourceHolding: z.string().optional().describe("Holding being sold (name/ticker). Pass this or sourceHoldingId."),
      sourceHoldingId: z.number().int().optional().describe("portfolio_holdings.id of the holding being sold."),
      sourceQty: z.number().positive().describe("Units of the source holding disposed (> 0)."),
      sourceProceeds: z.number().positive().describe("Proceeds realised from the source (> 0), in account/holding currency."),
      destHolding: z.string().optional().describe("Holding being acquired (name/ticker). Pass this or destHoldingId."),
      destHoldingId: z.number().int().optional().describe("portfolio_holdings.id of the holding being acquired."),
      destQty: z.number().positive().describe("Units of the destination holding acquired (> 0)."),
      destCost: z.number().positive().describe("Cost allocated to the destination (> 0)."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)."),
      payee: z.string().optional(),
      note: z.string().optional(),
    },
    async ({ account, account_id, sourceHolding, sourceHoldingId, sourceQty, sourceProceeds, destHolding, destHoldingId, destQty, destCost, date, payee, note }) => {
      if (!dek) return err("portfolio_swap requires an active session DEK — log in again to encrypt the rows.");
      const accounts = await loadOpAccounts();
      const a = resolveOpAccount("account", account, account_id, accounts);
      if (!a.ok) return err(a.error);
      const src = await resolveOpHolding("sourceHolding", Number(a.acct.id), sourceHolding, sourceHoldingId);
      if (!src.ok) return err(src.error);
      const dst = await resolveOpHolding("destHolding", Number(a.acct.id), destHolding, destHoldingId);
      if (!dst.ok) return err(dst.error);
      const txDate = date ?? today();
      try {
        const result = await recordSwap({ userId, dek, accountId: Number(a.acct.id), sourceHoldingId: src.id, sourceQty, sourceProceeds, destHoldingId: dst.id, destQty, destCost, date: txDate, payee, note, source: "mcp_http" });
        invalidateUserTxCache(userId);
        await markSnapshotsDirty(userId, txDate);
        return text({ success: true, data: { ...result, resolvedAccount: { id: Number(a.acct.id), name: String(a.acct.name ?? "") }, message: `Swapped ${sourceQty} × #${src.id} → ${destQty} × #${dst.id} on ${txDate} in ${a.acct.name}.` } });
      } catch (e) {
        const m = mapPortfolioOpError(e);
        if (m) return err(m);
        throw e;
      }
    }
  );


  server.tool(
    "portfolio_transfer",
    "Move shares/units of the SAME holding between two different brokerage accounts (in-kind, no cash). Cascades cost basis from source to destination. The holding is resolved in the SOURCE account; source and destination accounts must differ. CREATE-ONLY.",
    {
      sourceAccount: z.string().optional().describe("Source brokerage account name or alias. Pass this or sourceAccount_id."),
      sourceAccount_id: z.number().int().optional().describe("Source account id (exact; wins over name)."),
      destAccount: z.string().optional().describe("Destination brokerage account name or alias. Pass this or destAccount_id."),
      destAccount_id: z.number().int().optional().describe("Destination account id (exact; wins over name)."),
      holding: z.string().optional().describe("Holding to move (name/ticker), resolved in the source account. Pass this or holdingId."),
      holdingId: z.number().int().optional().describe("portfolio_holdings.id of the holding (in the source account)."),
      qty: z.number().positive().describe("Units leaving source / arriving at destination (> 0)."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)."),
      payee: z.string().optional(),
      note: z.string().optional(),
    },
    async ({ sourceAccount, sourceAccount_id, destAccount, destAccount_id, holding, holdingId, qty, date, payee, note }) => {
      if (!dek) return err("portfolio_transfer requires an active session DEK — log in again to encrypt the rows.");
      const accounts = await loadOpAccounts();
      const src = resolveOpAccount("sourceAccount", sourceAccount, sourceAccount_id, accounts);
      if (!src.ok) return err(src.error);
      const dst = resolveOpAccount("destAccount", destAccount, destAccount_id, accounts);
      if (!dst.ok) return err(dst.error);
      const h = await resolveOpHolding("holding", Number(src.acct.id), holding, holdingId);
      if (!h.ok) return err(h.error);
      const txDate = date ?? today();
      try {
        const result = await recordInKindTransfer({ userId, dek, sourceAccountId: Number(src.acct.id), destAccountId: Number(dst.acct.id), holdingId: h.id, qty, date: txDate, payee, note, source: "mcp_http" });
        invalidateUserTxCache(userId);
        await markSnapshotsDirty(userId, txDate);
        return text({ success: true, data: { ...result, resolvedSourceAccount: { id: Number(src.acct.id), name: String(src.acct.name ?? "") }, resolvedDestAccount: { id: Number(dst.acct.id), name: String(dst.acct.name ?? "") }, message: `Transferred ${qty} × holding #${h.id} from ${src.acct.name} to ${dst.acct.name} on ${txDate}.` } });
      } catch (e) {
        const m = mapPortfolioOpError(e);
        if (m) return err(m);
        throw e;
      }
    }
  );


  server.tool(
    "portfolio_income_expense",
    "Record portfolio income (dividend/interest, amount > 0) or an expense (fee, amount < 0) on a brokerage cash sleeve. The cash sleeve for `currency` must already exist. `incomeType` resolves the canonical category (Dividends/Interest/Fees) when no explicit categoryId is given and the sign matches. Optionally tie the row to the holding that earned it via relatedHolding/relatedHoldingId. CREATE-ONLY.",
    {
      account: z.string().optional().describe("Brokerage account name or alias. Pass this or account_id."),
      account_id: z.number().int().optional().describe("Brokerage account id (exact; wins over name)."),
      currency: supportedCurrencyEnum.describe("Currency of the cash sleeve to credit/debit (ISO code)."),
      amount: z.number().refine((v) => v !== 0, { message: "amount cannot be 0" }).describe("Positive = income (dividend/interest), negative = expense (fee)."),
      incomeType: z.enum(["dividend", "interest", "fee", "other"]).optional().describe("Category hint. dividend/interest apply to income (amount>0); fee to expense (amount<0); other leaves the category unset. Ignored when categoryId is given."),
      relatedHolding: z.string().optional().describe("Holding (name/ticker) this income/expense relates to, for reporting. Pass this or relatedHoldingId."),
      relatedHoldingId: z.number().int().optional().describe("portfolio_holdings.id this relates to."),
      categoryId: z.number().int().optional().describe("Explicit category id (overrides incomeType)."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)."),
      payee: z.string().optional(),
      note: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ account, account_id, currency, amount, incomeType, relatedHolding, relatedHoldingId, categoryId, date, payee, note, tags }) => {
      if (!dek) return err("portfolio_income_expense requires an active session DEK — log in again to encrypt the rows.");
      const accounts = await loadOpAccounts();
      const a = resolveOpAccount("account", account, account_id, accounts);
      if (!a.ok) return err(a.error);
      let relatedId: number | null = null;
      if (relatedHolding != null || relatedHoldingId != null) {
        const rh = await resolveOpHolding("relatedHolding", Number(a.acct.id), relatedHolding, relatedHoldingId);
        if (!rh.ok) return err(rh.error);
        relatedId = rh.id;
      }
      // Category precedence mirrors the REST route: explicit categoryId wins;
      // else map the income type to its canonical category when the sign agrees.
      let resolvedCategoryId: number | null = categoryId ?? null;
      if (resolvedCategoryId == null && incomeType && incomeType !== "other") {
        const wantIncome = incomeType === "dividend" || incomeType === "interest";
        if ((wantIncome && amount > 0) || (incomeType === "fee" && amount < 0)) {
          resolvedCategoryId = await resolveOrCreateInvestmentIncomeCategory(db, userId, dek, incomeType);
        }
      }
      const txDate = date ?? today();
      try {
        const result = await recordPortfolioIncomeOrExpense({ userId, dek, accountId: Number(a.acct.id), currency, amount, relatedHoldingId: relatedId, categoryId: resolvedCategoryId, date: txDate, payee, note, tags, source: "mcp_http" });
        invalidateUserTxCache(userId);
        await markSnapshotsDirty(userId, txDate);
        return text({ success: true, data: { ...result, resolvedAccount: { id: Number(a.acct.id), name: String(a.acct.name ?? "") }, message: `Recorded ${result.kind} ${amount} ${currency} on ${txDate} in ${a.acct.name}.` } });
      } catch (e) {
        const m = mapPortfolioOpError(e);
        if (m) return err(m);
        throw e;
      }
    }
  );


  server.tool(
    "portfolio_fx_conversion",
    "Convert cash from one currency to another inside a SINGLE brokerage account (e.g. USD sleeve → CAD sleeve). Writes fx_from + fx_to (+ optional fx_fee). Both currency sleeves (and the fee sleeve, if any) must already exist. CREATE-ONLY.",
    {
      account: z.string().optional().describe("Brokerage account name or alias. Pass this or account_id."),
      account_id: z.number().int().optional().describe("Brokerage account id (exact; wins over name)."),
      fromCurrency: supportedCurrencyEnum.describe("Currency debited (source sleeve)."),
      fromAmount: z.number().positive().describe("Amount debited from the source sleeve (> 0)."),
      toCurrency: supportedCurrencyEnum.describe("Currency credited (destination sleeve)."),
      toAmount: z.number().positive().describe("Amount credited to the destination sleeve (> 0)."),
      feeAmount: z.number().positive().optional().describe("Optional conversion fee (> 0)."),
      feeCurrency: supportedCurrencyEnum.optional().describe("Currency of the fee."),
      feeOnSleeveCurrency: supportedCurrencyEnum.optional().describe("Which sleeve currency absorbs the fee (defaults to feeCurrency)."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)."),
      payee: z.string().optional(),
      note: z.string().optional(),
    },
    async ({ account, account_id, fromCurrency, fromAmount, toCurrency, toAmount, feeAmount, feeCurrency, feeOnSleeveCurrency, date, payee, note }) => {
      if (!dek) return err("portfolio_fx_conversion requires an active session DEK — log in again to encrypt the rows.");
      const accounts = await loadOpAccounts();
      const a = resolveOpAccount("account", account, account_id, accounts);
      if (!a.ok) return err(a.error);
      const txDate = date ?? today();
      try {
        const result = await recordFxConversion({ userId, dek, accountId: Number(a.acct.id), fromCurrency, fromAmount, toCurrency, toAmount, feeAmount, feeCurrency, feeOnSleeveCurrency, date: txDate, payee, note, source: "mcp_http" });
        invalidateUserTxCache(userId);
        await markSnapshotsDirty(userId, txDate);
        return text({ success: true, data: { ...result, resolvedAccount: { id: Number(a.acct.id), name: String(a.acct.name ?? "") }, message: `Converted ${fromAmount} ${fromCurrency} → ${toAmount} ${toCurrency} on ${txDate} in ${a.acct.name}.` } });
      } catch (e) {
        const m = mapPortfolioOpError(e);
        if (m) return err(m);
        throw e;
      }
    }
  );


  server.tool(
    "portfolio_deposit",
    "Fund a brokerage cash sleeve from a non-investment (bank/chequing) account. Writes a brokerage_deposit_out / brokerage_deposit_in pair linked by link_id. The destination cash sleeve must already exist (or pass destCashSleeveHoldingId). CREATE-ONLY.",
    {
      sourceAccount: z.string().optional().describe("Source (non-investment) account name or alias. Pass this or sourceAccount_id."),
      sourceAccount_id: z.number().int().optional().describe("Source account id (exact; wins over name)."),
      destAccount: z.string().optional().describe("Destination brokerage account name or alias. Pass this or destAccount_id."),
      destAccount_id: z.number().int().optional().describe("Destination brokerage account id (exact; wins over name)."),
      destCashSleeveHoldingId: z.number().int().optional().describe("Explicit destination cash sleeve; defaults to the brokerage's cash sleeve for the amount currency."),
      amount: z.number().positive().describe("Amount transferred (> 0)."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)."),
      payee: z.string().optional(),
      note: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ sourceAccount, sourceAccount_id, destAccount, destAccount_id, destCashSleeveHoldingId, amount, date, payee, note, tags }) => {
      if (!dek) return err("portfolio_deposit requires an active session DEK — log in again to encrypt the rows.");
      const accounts = await loadOpAccounts();
      const src = resolveOpAccount("sourceAccount", sourceAccount, sourceAccount_id, accounts);
      if (!src.ok) return err(src.error);
      const dst = resolveOpAccount("destAccount", destAccount, destAccount_id, accounts);
      if (!dst.ok) return err(dst.error);
      const txDate = date ?? today();
      try {
        const result = await recordBrokerageDeposit({ userId, dek, sourceAccountId: Number(src.acct.id), destAccountId: Number(dst.acct.id), destCashSleeveHoldingId, amount, date: txDate, payee, note, tags, source: "mcp_http" });
        invalidateUserTxCache(userId);
        await markSnapshotsDirty(userId, txDate);
        return text({ success: true, data: { ...result, resolvedSourceAccount: { id: Number(src.acct.id), name: String(src.acct.name ?? "") }, resolvedDestAccount: { id: Number(dst.acct.id), name: String(dst.acct.name ?? "") }, message: `Deposited ${amount} from ${src.acct.name} into ${dst.acct.name} on ${txDate}.` } });
      } catch (e) {
        const m = mapPortfolioOpError(e);
        if (m) return err(m);
        throw e;
      }
    }
  );


  server.tool(
    "portfolio_withdrawal",
    "Withdraw cash from a brokerage cash sleeve to a non-investment (bank/chequing) account. Writes a brokerage_withdrawal_out / brokerage_withdrawal_in pair linked by link_id. The source cash sleeve must already exist (or pass sourceCashSleeveHoldingId). CREATE-ONLY.",
    {
      sourceAccount: z.string().optional().describe("Source brokerage account name or alias. Pass this or sourceAccount_id."),
      sourceAccount_id: z.number().int().optional().describe("Source brokerage account id (exact; wins over name)."),
      sourceCashSleeveHoldingId: z.number().int().optional().describe("Explicit source cash sleeve; defaults to the brokerage's cash sleeve for the amount currency."),
      destAccount: z.string().optional().describe("Destination (non-investment) account name or alias. Pass this or destAccount_id."),
      destAccount_id: z.number().int().optional().describe("Destination account id (exact; wins over name)."),
      amount: z.number().positive().describe("Amount withdrawn (> 0)."),
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)."),
      payee: z.string().optional(),
      note: z.string().optional(),
      tags: z.string().optional(),
    },
    async ({ sourceAccount, sourceAccount_id, sourceCashSleeveHoldingId, destAccount, destAccount_id, amount, date, payee, note, tags }) => {
      if (!dek) return err("portfolio_withdrawal requires an active session DEK — log in again to encrypt the rows.");
      const accounts = await loadOpAccounts();
      const src = resolveOpAccount("sourceAccount", sourceAccount, sourceAccount_id, accounts);
      if (!src.ok) return err(src.error);
      const dst = resolveOpAccount("destAccount", destAccount, destAccount_id, accounts);
      if (!dst.ok) return err(dst.error);
      const txDate = date ?? today();
      try {
        const result = await recordBrokerageWithdrawal({ userId, dek, sourceAccountId: Number(src.acct.id), destAccountId: Number(dst.acct.id), sourceCashSleeveHoldingId, amount, date: txDate, payee, note, tags, source: "mcp_http" });
        invalidateUserTxCache(userId);
        await markSnapshotsDirty(userId, txDate);
        return text({ success: true, data: { ...result, resolvedSourceAccount: { id: Number(src.acct.id), name: String(src.acct.name ?? "") }, resolvedDestAccount: { id: Number(dst.acct.id), name: String(dst.acct.name ?? "") }, message: `Withdrew ${amount} from ${src.acct.name} to ${dst.acct.name} on ${txDate}.` } });
      } catch (e) {
        const m = mapPortfolioOpError(e);
        if (m) return err(m);
        throw e;
      }
    }
  );


  // ── add_snapshot ───────────────────────────────────────────────────────────
  server.tool(
    "add_snapshot",
    "Record a net-worth snapshot for tracking wealth over time",
    {
      date: ymdDate.optional().describe("YYYY-MM-DD (default: today)"),
      note: z.string().optional(),
    },
    async ({ date, note }) => {
      const snapshotDate = date ?? new Date().toISOString().split("T")[0];
      const balances = await q(db, sql`
        SELECT a.currency, COALESCE(SUM(t.amount), 0) as balance
        FROM accounts a
        LEFT JOIN transactions t ON t.account_id = a.id AND t.user_id = ${userId}
        WHERE a.user_id = ${userId}
        GROUP BY a.id, a.currency
      `);
      const totalByCurrency: Record<string, number> = {};
      for (const b of balances) {
        totalByCurrency[b.currency] = (totalByCurrency[b.currency] ?? 0) + Number(b.balance);
      }
      await db.execute(sql`
        INSERT INTO net_worth_snapshots (user_id, date, balances, note)
        VALUES (${userId}, ${snapshotDate}, ${JSON.stringify(totalByCurrency)}, ${encNote(note)})
      `);
      return text({ success: true, data: { date: snapshotDate, balances: totalByCurrency } });
    }
  );


  // ── add_portfolio_holding ──────────────────────────────────────────────────
  server.tool(
    "add_portfolio_holding",
    "Create a portfolio holding (a single position like 'VEQT.TO' inside a brokerage account). The import pipeline auto-creates these from CSV/ZIP uploads; this tool is for manually adding a position the user wants to track without an import.",
    {
      name: z.string().min(1).max(200).describe("Display name of the holding (e.g. 'Vanguard All-Equity ETF')"),
      account: z.string().describe("Brokerage account name or alias (fuzzy matched against name; exact match on alias). Required because uniqueness is scoped per (account, name)."),
      symbol: z.string().max(50).optional().describe("Ticker symbol (e.g. 'VEQT.TO', 'BTC')"),
      currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency (default: parent account's currency). Issue #206: full SUPPORTED_CURRENCIES list."),
      isCrypto: z.boolean().optional().describe("Flag this holding as crypto (default: false)"),
      note: z.string().max(500).optional(),
    },
    async ({ name, account, symbol, currency, isCrypto, note }) => {
      const rawAccounts = await q(db, sql`
        SELECT id, currency, name_ct, alias_ct FROM accounts
        WHERE user_id = ${userId} AND archived = false
      `);
      const allAccounts = decryptNameish(rawAccounts, dek);
      const acct = fuzzyFind(account, allAccounts);
      if (!acct) return err(`Account "${account}" not found`);

      // Stream D Phase 4: portfolio_holdings.name plaintext column dropped —
      // uniqueness gate now relies on name_lookup HMAC. No DEK ⇒ no lookup ⇒
      // we cannot run the pre-check, so let the DB UNIQUE backstop raise
      // 23505 (caught below as `unique`) instead of silently inserting a dup.
      const lookup = dek ? nameLookup(dek, name) : null;
      if (lookup) {
        const existing = await q(db, sql`
          SELECT id FROM portfolio_holdings
          WHERE user_id = ${userId} AND account_id = ${acct.id}
            AND name_lookup = ${lookup}
        `);
        if (existing.length) {
          return err(`Holding "${name}" already exists in account "${acct.name}" (id: ${existing[0].id})`);
        }
      }

      const symbolValue = symbol && symbol.trim() ? symbol.trim() : null;
      const nameEnc = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      const symbolEnc = dek ? encryptName(dek, symbolValue) : { ct: null, lookup: null };
      const cur = currency ?? String(acct.currency ?? "CAD");
      // Securities master (Phase B) — dual-write security_id. MCP read-flip is
      // deferred (the legacy path stays), but populating it now means no extra
      // backfill when the MCP read tools flip later. Null DEK (stdio) ⇒ null;
      // the login-time backfill reconciles on the user's next web login.
      const securityId = await resolveOrCreateSecurity(userId, dek, {
        symbol: symbolValue,
        name,
        isCryptoFlag: !!isCrypto,
        isCash: false,
        currency: cur,
      });

      try {
        // Issue #95: dual-write portfolio_holdings + holding_accounts. Every
        // aggregator (issue #25) JOINs through holding_accounts on
        // (holding_id, account_id, user_id); a holding without that pairing
        // is invisible to get_portfolio_analysis, get_portfolio_performance,
        // and analyze_holding. is_primary=true because every fresh holding
        // starts single-account; the legacy portfolio_holdings.account_id
        // mirror invariant (schema-pg.ts is_primary docstring) requires
        // exactly one primary row per holding while the legacy column
        // exists. DbLike here is `{ execute }`-only so we can't open a
        // Drizzle transaction; instead, on holding_accounts INSERT failure
        // we DELETE the orphan portfolio_holdings row to avoid leaving the
        // user with an aggregator-invisible holding.
        // Stream D Phase 4 — plaintext name/symbol dropped.
        const result = await q(db, sql`
          INSERT INTO portfolio_holdings (
            user_id, account_id, currency, is_crypto, security_id, note,
            name_ct, name_lookup, symbol_ct, symbol_lookup
          )
          VALUES (
            ${userId}, ${acct.id}, ${cur}, ${isCrypto ? 1 : 0}, ${securityId}, ${note ?? ""},
            ${nameEnc.ct}, ${nameEnc.lookup}, ${symbolEnc.ct}, ${symbolEnc.lookup}
          )
          RETURNING id
        `);
        const holdingId = Number(result[0]?.id);
        if (!holdingId) {
          return err(`Failed to create holding "${name}" in "${acct.name}"`);
        }
        // qty=0 / cost_basis=0 match migrate-holding-accounts.sql's fresh-row
        // defaults; aggregators derive live qty/cost from transactions
        // (CLAUDE.md "Portfolio aggregator" — DO NOT switch to cached cols).
        try {
          await q(db, sql`
            INSERT INTO holding_accounts (holding_id, account_id, user_id, qty, cost_basis, is_primary)
            VALUES (${holdingId}, ${acct.id}, ${userId}, 0, 0, true)
            ON CONFLICT (holding_id, account_id) DO NOTHING
          `);
        } catch (pairingErr) {
          await q(db, sql`
            DELETE FROM portfolio_holdings WHERE id = ${holdingId} AND user_id = ${userId}
          `);
          throw pairingErr;
        }
        return text({
          success: true,
          data: {
            holdingId,
            message: `Holding "${name}" created in "${acct.name}"${symbolValue ? ` (${symbolValue})` : ""} — pass holdingId=${holdingId} as portfolioHoldingId on record_transaction to bind transactions.`,
          },
        });
      } catch (e) {
        // 23505 = unique_violation on the partial index (race with another
        // concurrent add for the same name in the same account).
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
          return err(`Holding "${name}" already exists in account "${acct.name}"`);
        }
        throw e;
      }
    }
  );


  // ── update_portfolio_holding ───────────────────────────────────────────────
  server.tool(
    "update_portfolio_holding",
    "Update a portfolio holding's name, symbol, currency, isCrypto, or note. Renames cascade to all transactions automatically because the portfolio aggregators (issue #86) group by FK holdingId, not by display name — two holdings sharing a name across accounts stay distinct rows in get_portfolio_analysis output. NOTE: the legacy `account` parameter is REFUSED (issue #99) — moving a holding to a different account would leave stale `holding_accounts` rows and orphaned account attribution on every historical transaction. To actually move shares between accounts, use record_transfer (in-kind); to re-attribute existing transactions, update them individually.",
    {
      holding: z.string().describe("Current holding name OR symbol (fuzzy matched against decrypted name and symbol)"),
      name: z.string().min(1).max(200).optional().describe("New name"),
      symbol: z.string().max(50).optional().describe("New symbol (pass empty string to clear)"),
      account: z.string().optional().describe("REFUSED (issue #99): account moves create stale state. Use record_transfer (in-kind) to move shares between accounts; update individual transactions to re-attribute history."),
      currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency code (issue #206: full SUPPORTED_CURRENCIES list)."),
      isCrypto: z.boolean().optional(),
      note: z.string().max(500).optional(),
    },
    async ({ holding, name, symbol, account, currency, isCrypto, note }) => {
      // Issue #99: refuse account-move. Updating only portfolio_holdings.account_id
      // (the prior behavior) leaves a stale (holding, old_account) row in
      // holding_accounts (issue #25's JOIN grain) AND broken account
      // attribution on every prior transaction whose account_id still
      // references the old account. Bulk-rewriting historical transaction
      // account_ids would destroy the audit trail. The semantically correct
      // path is record_transfer (in-kind), which atomically books the move
      // as a transfer pair.
      if (account !== undefined) {
        return err(
          `Moving a holding to a different account is no longer supported via update_portfolio_holding (issue #99). Stale aggregator state and orphaned transaction account attribution were the failure modes. Instead: use record_transfer with in-kind semantics (holding=<name>, quantity=<shares>) to move shares to a new account, OR update individual transactions' account_id with update_transaction.`
        );
      }

      const rawHoldings = await q(db, sql`
        SELECT id, account_id, name_ct, symbol_ct, security_id, currency, is_crypto, is_cash
        FROM portfolio_holdings
        WHERE user_id = ${userId}
      `);
      const allHoldings = decryptNameish(rawHoldings, dek);
      // Match by name first (the existing fuzzyFind behavior), then by symbol
      // exact-then-startsWith if name didn't hit. Symbol is a separate signal
      // — matching it as if it were a name (substring on name) would surface
      // a totally unrelated holding.
      let h: Row | null = fuzzyFind(holding, allHoldings);
      if (!h) {
        const lo = holding.toLowerCase().trim();
        h =
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase() === lo) ??
          allHoldings.find((r) => String(r.symbol ?? "").toLowerCase().startsWith(lo)) ??
          null;
      }
      if (!h) return err(`Holding "${holding}" not found`);

      // Stream D Phase 4 — plaintext name/symbol dropped.
      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) {
        if (!dek) return err("Cannot rename holding without an unlocked DEK (Stream D Phase 4).");
        const n = encryptName(dek, name);
        updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
      }
      if (symbol !== undefined) {
        const trimmed = symbol.trim();
        const symbolValue = trimmed ? trimmed : null;
        if (!dek) return err("Cannot update symbol without an unlocked DEK (Stream D Phase 4).");
        const s = encryptName(dek, symbolValue);
        updates.push(sql`symbol_ct = ${s.ct}`, sql`symbol_lookup = ${s.lookup}`);
      }
      if (currency !== undefined) updates.push(sql`currency = ${currency}`);
      if (isCrypto !== undefined) updates.push(sql`is_crypto = ${isCrypto ? 1 : 0}`);
      if (note !== undefined) updates.push(sql`note = ${note}`);
      if (!updates.length) return err("No fields to update");

      // Securities master edit-path dual-write (parity with PUT /api/portfolio):
      // re-cluster the position under the NEW identity when symbol/name/currency/
      // isCrypto changes. Null DEK (stdio) ⇒ resolveOrCreateSecurity returns null
      // ⇒ security_id untouched (the login backfill reconciles on next web login).
      const oldSecurityId: number | null =
        h.security_id != null ? Number(h.security_id) : null;
      let securityChanged = false;
      if (name !== undefined || symbol !== undefined || currency !== undefined || isCrypto !== undefined) {
        const nextName = name !== undefined ? name : ((h.name as string | null) ?? null);
        const nextSymbol =
          symbol !== undefined
            ? (symbol.trim() ? symbol.trim() : null)
            : ((h.symbol as string | null) ?? null);
        const nextCurrency = currency !== undefined ? currency : String(h.currency ?? "");
        const nextIsCrypto = isCrypto !== undefined ? isCrypto : Number(h.is_crypto ?? 0) === 1;
        const resolved = await resolveOrCreateSecurity(userId, dek, {
          symbol: nextSymbol,
          name: nextName,
          isCryptoFlag: nextIsCrypto,
          isCash: h.is_cash === true,
          currency: nextCurrency,
        });
        if (resolved != null && resolved !== oldSecurityId) {
          updates.push(sql`security_id = ${resolved}`);
          securityChanged = true;
        }
      }

      try {
        const result = await db.execute(
          sql`UPDATE portfolio_holdings SET ${sql.join(updates, sql`, `)} WHERE id = ${h.id} AND user_id = ${userId}`
        );
        const affected =
          (result && typeof result === "object" && "rowCount" in result && typeof (result as { rowCount: unknown }).rowCount === "number")
            ? (result as { rowCount: number }).rowCount
            : null;
        if (affected === 0) return err(`Holding "${h.name}" not found or not owned by this user`);
        // GC the prior security if this edit left it backing zero positions.
        if (securityChanged) await gcOrphanSecurity(userId, oldSecurityId);
        return text({ success: true, data: { holdingId: h.id, message: `Holding "${h.name}" updated` } });
      } catch (e) {
        // 23505 = unique_violation: tried to rename into an existing
        // (account_id, name_lookup) pair.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("23505") || msg.toLowerCase().includes("unique")) {
          return err(`Another holding with name "${name ?? h.name}" already exists in this account`);
        }
        throw e;
      }
    }
  );


  // ── delete_portfolio_holding ───────────────────────────────────────────────
  server.tool(
    "delete_portfolio_holding",
    "Delete a portfolio holding. Transactions referencing it survive — the FK is set to NULL automatically (no data loss; they fall back to the orphan-aggregation path until reassigned).",
    {
      holding: z.string().describe("Holding name OR symbol (fuzzy matched)"),
    },
    async ({ holding }) => {
      const rawHoldings = await q(db, sql`
        SELECT id, name_ct, symbol_ct
        FROM portfolio_holdings
        WHERE user_id = ${userId}
      `);
      const allHoldings = decryptNameish(rawHoldings, dek);
      // Issue #127: resolve via strict matcher gated on token overlap so a
      // tiny-named holding (e.g. "S") cannot silently swallow a longer input
      // (e.g. "TESTV") via fuzzyFind's reverse-includes branch and DELETE
      // the wrong row. Reads still tolerate fuzziness; destructive paths do not.
      const resolved = resolvePortfolioHoldingStrict(holding, allHoldings);
      if (!resolved.ok) {
        if (resolved.reason === "low_confidence") {
          const sName = String(resolved.suggestion.name ?? "");
          return err(`Holding "${holding}" did not match strongly — did you mean "${sName}" (id=${Number(resolved.suggestion.id)})? Re-call with the exact name to confirm.`);
        }
        return err(`Holding "${holding}" not found`);
      }
      const h = resolved.holding;
      // Capture decrypted name BEFORE the DELETE so the response renders
      // truthful state, not whatever the matcher landed on after a stale read.
      const matchedName = String(h.name ?? "");

      const txnCount = await q(db, sql`
        SELECT COUNT(*) AS cnt FROM transactions
        WHERE user_id = ${userId} AND portfolio_holding_id = ${h.id}
      `);
      const count = Number(txnCount[0]?.cnt ?? 0);

      await db.execute(sql`DELETE FROM portfolio_holdings WHERE id = ${h.id} AND user_id = ${userId}`);
      // Per CLAUDE.md "Every MCP tx-mutating write must call invalidateUser":
      // FK ON DELETE SET NULL mutates linked transactions' portfolio_holding_id,
      // so the per-user tx cache must be invalidated.
      invalidateUserTxCache(userId);
      return text({
        success: true,
        data: {
          message: count > 0
            ? `Holding "${matchedName}" deleted; ${count} transaction(s) unlinked (still queryable, no longer aggregated under this holding).`
            : `Holding "${matchedName}" deleted.`,
        },
      });
    }
  );


  // ── get_portfolio_performance_v2 ───────────────────────────────────────────
  // Phase 3 of plan/portfolio-lots-and-performance.md — TWRR + MWRR + daily
  // value series from portfolio_snapshots. Distinct from get_portfolio_performance
  // (which is the avg-cost legacy aggregate); v2 reads pre-built snapshots
  // populated by the nightly cron + backfill script.
  server.tool(
    "get_portfolio_performance_v2",
    "Compute a portfolio time-series return series. Returns daily market_value + cost_basis, period TWRR (Modified Dietz chained daily), annualized TWRR, and MWRR / XIRR. Distinct capability from get_portfolio_performance (which is per-holding average-cost realized P&L), NOT a newer version of it. Reads `portfolio_snapshots` populated by the nightly cron + admin backfill script. `gapsFilledDays` count flags any range where price_cache or fx_rates fell back to last-known values.",
    {
      period: z.enum(["1m", "3m", "6m", "ytd", "1y", "all"]).optional().describe("Lookback period; defaults to '1y'"),
      accountId: z.number().int().optional().describe("Scope to one accounts.id; omit for whole-portfolio aggregate"),
    },
    async ({ period, accountId }) => {
      const PERIOD_DAYS: Record<string, number | null> = {
        "1m": 30, "3m": 90, "6m": 180, ytd: -1, "1y": 365, all: null,
      };
      const asOfDate = new Date().toISOString().slice(0, 10);
      const p = period ?? "1y";
      let from: string;
      if (p === "ytd") from = `${asOfDate.slice(0, 4)}-01-01`;
      else {
        const days = PERIOD_DAYS[p];
        if (days == null) from = "1900-01-01";
        else {
          const d = new Date(`${asOfDate}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() - days);
          from = d.toISOString().slice(0, 10);
        }
      }

      const rowsRaw = await q(db, sql`
        SELECT
          snap_date AS date,
          market_value,
          cost_basis,
          net_contribution AS contribution,
          currency,
          gaps_filled
        FROM portfolio_snapshots
        WHERE user_id = ${userId}
          AND snap_date >= ${from}
          AND snap_date <= ${asOfDate}
          AND ${accountId != null ? sql`account_id = ${accountId}` : sql`account_id IS NULL`}
        ORDER BY snap_date
      `);
      const series = (rowsRaw as Array<{
        date: string;
        market_value: number;
        cost_basis: number;
        contribution: number;
        currency: string;
        gaps_filled: boolean;
      }>).map((r) => ({
        date: r.date,
        marketValue: Number(r.market_value),
        costBasis: Number(r.cost_basis),
        contribution: Number(r.contribution),
        gapsFilled: r.gaps_filled,
      }));

      const { computeTwrr, annualizeReturn } = await import(
        "../../src/lib/portfolio/performance/twrr"
      );
      const { computeMwrr } = await import(
        "../../src/lib/portfolio/performance/mwrr"
      );
      const { computeNetContributions } = await import(
        "../../src/lib/portfolio/performance/contributions"
      );

      const twrr = computeTwrr(
        series.map((p) => ({
          date: p.date,
          marketValue: p.marketValue,
          contribution: p.contribution,
        })),
      );
      let mwrr: { irr: number; converged: boolean } = { irr: 0, converged: false };
      if (series.length > 0) {
        const flows = await computeNetContributions({
          userId,
          accountId: accountId ?? null,
          fromDate: from,
          toDate: asOfDate,
        });
        const startMv = series[0]?.marketValue ?? 0;
        if (startMv > 0) flows.unshift({ date: from, amount: -startMv });
        const finalMv = series[series.length - 1]?.marketValue ?? 0;
        const result = computeMwrr(flows, finalMv, asOfDate);
        mwrr = { irr: result.irr, converged: result.converged };
      }

      const periodDays = series.length >= 2
        ? Math.max(1, Math.round((Date.parse(series[series.length - 1].date) - Date.parse(series[0].date)) / 86400000))
        : 0;
      const twrrAnnualized = annualizeReturn(twrr.periodReturn, periodDays);

      // FINLYNQ-254: divergence sanity flag. TWRR (time-weighted) and MWRR
      // (money-weighted) legitimately differ with flow timing, but a large
      // spread signals that transfer/FX flows may be mis-stamped in the daily
      // net_contribution (entering Dietz as performance rather than a pure
      // flow). Compare the two on the SAME (annualized) basis — mwrr.irr is
      // already annualized — and surface a flag + note when the gap exceeds
      // the threshold, the way gapsFilledDays is surfaced. Only meaningful when
      // the MWRR actually converged.
      const DIVERGENCE_THRESHOLD = 0.15; // 15 percentage points, annualized
      const divergenceAbs = mwrr.converged
        ? Math.abs(twrrAnnualized - mwrr.irr)
        : null;
      const divergenceFlag = divergenceAbs != null && divergenceAbs > DIVERGENCE_THRESHOLD;

      return text({
        success: true,
        data: {
          period: p,
          accountId: accountId ?? null,
          from,
          to: asOfDate,
          currency: (rowsRaw as Array<{ currency?: string }>)[0]?.currency ?? "USD",
          series,
          twrr: {
            period: twrr.periodReturn,
            annualized: twrrAnnualized,
            hadContributions: twrr.hadContributions,
          },
          mwrr,
          gapsFilledDays: series.filter((p) => p.gapsFilled).length,
          divergenceFlag,
          divergenceThreshold: DIVERGENCE_THRESHOLD,
          divergenceAbs,
          divergenceNote: divergenceFlag
            ? `Annualized TWRR (${(twrrAnnualized * 100).toFixed(1)}%) and MWRR (${(mwrr.irr * 100).toFixed(1)}%) differ by ${((divergenceAbs ?? 0) * 100).toFixed(1)}pp, exceeding the ${(DIVERGENCE_THRESHOLD * 100).toFixed(0)}pp sanity threshold. A large spread can be legitimate (heavy/early flows) but may also indicate transfer or FX-conversion flows mis-stamped in the daily net_contribution series — verify the flagged range.`
            : null,
        },
      });
    },
  );


  // ── get_realized_gains ─────────────────────────────────────────────────────
  // Phase 2 of plan/portfolio-lots-and-performance.md — reads
  // `holding_lot_closures` populated by Phase 1's lot engine.
  server.tool(
    "get_realized_gains",
    "Lot-level realized gains for the user, sourced from the FIFO lot engine. One row per closure (a sell that consumed a buy lot). Filter by tax year, date range, holding/account, or term (short ≤365d / long >365d / all). Each row carries pre-computed `realizedGain` in the holding's own currency (post issue #96 paired-cash-leg substitution) AND a `realizedGainInBase` converted into the user's display currency at historical FX; `totalRealizedGainInBase` is the unified grand total. FINLYNQ-183: the unified view is ALWAYS the user's display currency — there is no base/reporting-currency override parameter. Pre-Phase-1 history requires running the lot-backfill admin script.",
    {
      from: z.string().optional().describe("Inclusive close_date lower bound, YYYY-MM-DD"),
      to: z.string().optional().describe("Inclusive close_date upper bound, YYYY-MM-DD"),
      taxYear: z.number().int().optional().describe("Convenience: sets from=YYYY-01-01, to=YYYY-12-31"),
      holdingId: z.number().int().optional().describe("Scope to one portfolio_holdings.id"),
      accountId: z.number().int().optional().describe("Scope to one accounts.id"),
      term: z.enum(["short", "long", "all"]).optional().describe("Holding-period term (US tax convention; days_held threshold = 365)"),
    },
    async ({ from, to, taxYear, holdingId, accountId, term }) => {
      const { listRealizedGainClosures, augmentWithBaseCurrency } = await import("../../src/lib/portfolio/realized-gains");
      const result = await listRealizedGainClosures(userId, dek, {
        from,
        to,
        taxYear,
        holdingId,
        accountId,
        term: term ?? "all",
      });
      // FINLYNQ-183: report in the user's single display currency. No
      // override param — the unified figures are always the display ccy.
      const displayCurrency = await resolveReportingCurrency(db, userId, null);
      const augmented = await augmentWithBaseCurrency(result, userId, displayCurrency);
      return text({ success: true, data: augmented });
    },
  );


  // ── get_dividend_income ────────────────────────────────────────────────────
  // Phase 2 of plan/portfolio-lots-and-performance.md — reads transactions
  // by category_id (Dividends), respecting the issue #84 category-id rule.
  server.tool(
    "get_dividend_income",
    "Dividend income from the transactions table, classified by the user's Dividends category (issue #84). Includes cash dividends (qty=0), reinvested dividends (qty>0), and withholding-tax entries (amount<0, surfaced as separate `withholdingCount` per group, not netted). Group by year / quarter / holding, or omit `groupBy` to return raw rows.",
    {
      from: z.string().optional().describe("Inclusive lower bound on transactions.date, YYYY-MM-DD"),
      to: z.string().optional().describe("Inclusive upper bound on transactions.date, YYYY-MM-DD"),
      taxYear: z.number().int().optional().describe("Convenience: sets from=YYYY-01-01, to=YYYY-12-31"),
      holdingId: z.number().int().optional().describe("Scope to one portfolio_holdings.id"),
      accountId: z.number().int().optional().describe("Scope to one accounts.id"),
      groupBy: z.enum(["quarter", "year", "holding"]).optional().describe("Aggregation mode; omit for raw rows"),
    },
    async ({ from, to, taxYear, holdingId, accountId, groupBy }) => {
      const { listDividendIncome } = await import("../../src/lib/portfolio/dividends");
      const result = await listDividendIncome(userId, dek, {
        from,
        to,
        taxYear,
        holdingId,
        accountId,
        groupBy,
      });
      return text({ success: true, data: result });
    },
  );


  // ── get_portfolio_analysis ─────────────────────────────────────────────────
  server.tool(
    "get_portfolio_analysis",
    "List portfolio holdings with all investment metrics. Each row carries quantity, cost basis, avg cost, unrealized/realized gain, dividends, total return, and % of portfolio, one row per `holdingId` — two holdings sharing a display name across accounts (e.g. VUN.TO in TFSA + RRSP) appear as separate rows. Per-row amounts stay in each holding's native currency; summary aggregates convert to reportingCurrency (defaults to user's display currency). Pass `symbols` to filter (case-insensitive substring against `name + symbol + account`; tokens within an entry AND, across entries OR). Pass `account_id` (FK fast-path) or `account` (fuzzy name/alias) to scope to one account — `account_id` wins. The response includes a `warnings` array listing any filter entries that matched zero rows.",
    {
      symbols: z.array(z.string()).optional().describe("Filter to specific holding names/symbols/accounts (omit for all). Substring match against the row's `name + symbol + account` combination. Within a single entry, ALL whitespace/paren-separated tokens must match (AND) — so 'VCN.TO (TFSA)' matches only holdings whose combined name/symbol/account contains both 'vcn.to' and 'tfsa'. Across multiple entries the result is the union (OR). Unmatched entries surface in `warnings`."),
      account_id: z.number().int().optional().describe("Account FK (accounts.id). Skips fuzzy matching; scopes results to holdings in this account only. Wins over `account` if both are passed. Bad/foreign id returns empty `holdings` plus a warning entry."),
      account: z.string().optional().describe("Account name or alias (fuzzy matched, low-confidence rejected — issue #123). PREFER `account_id` when known. Unmatched/low-confidence entries surface in `warnings` with empty holdings."),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Used for the summary block totals."),
    },
    async ({ symbols, account_id, account, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);

      // Issue #123: scope to a single account when account_id or account is
      // passed. account_id wins (mirrors record_transaction's precedence).
      // Filter rides the existing holding_accounts JOIN grain (issue #25 —
      // (holding_id, account_id, user_id)) so this is just an additional
      // WHERE on portfolio_holdings; no new joins. On rejection (bad id /
      // unknown name / low confidence) we short-circuit to empty holdings +
      // a warning, matching the symbols-warnings contract from issue #86.
      const accountWarnings: string[] = [];
      let scopeAccountId: number | null = null;
      let scopeRejected = false;
      if (account_id != null) {
        const ownsRow = await q(db, sql`
          SELECT 1 AS ok FROM accounts WHERE id = ${account_id} AND user_id = ${userId}
        `);
        if (!ownsRow.length) {
          accountWarnings.push(`account_id=${account_id}: not found`);
          scopeRejected = true;
        } else {
          scopeAccountId = account_id;
        }
      } else if (account != null) {
        const rawAccounts = await q(db, sql`
          SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const resolved = resolveAccountStrict(account, allAccounts);
        if (!resolved.ok) {
          if (resolved.reason === "ambiguous") {
            const list = resolved.candidates
              .map(c => `${String(c.name ?? "")} id=${Number(c.id)}`)
              .join(", ");
            accountWarnings.push(`${account}: ambiguous (matches ${resolved.candidates.length} accounts: ${list}). Pass account_id to disambiguate.`);
          } else if (resolved.reason === "low_confidence") {
            accountWarnings.push(`${account}: no matching account (did you mean ${resolved.suggestion.name} id=${Number(resolved.suggestion.id)}?)`);
          } else {
            accountWarnings.push(`${account}: no matching account`);
          }
          scopeRejected = true;
        } else {
          scopeAccountId = Number(resolved.account.id);
        }
      }
      const todayStr = new Date().toISOString().split("T")[0];
      const fxCache = new Map<string, number>();
      const fxFor = async (ccy: string): Promise<number> => {
        const k = (ccy || reporting).toUpperCase();
        if (fxCache.has(k)) return fxCache.get(k)!;
        const r = await getRate(k, reporting, todayStr, userId);
        fxCache.set(k, r);
        return r;
      };

      // Issue #123: when the caller passed an account scope and it failed to
      // resolve, short-circuit to empty holdings + the warnings array. Same
      // shape as a successful empty result (no error) so callers stay
      // monomorphic — mirrors the symbols-all-unmatched warnings contract.
      // Issue #209: dropped the mixed-currency raw `totalCostBasis` /
      // `lifetimeCostBasis` / etc. fields — only `*Reporting` siblings remain
      // (currency-converted, the canonical totals).
      if (scopeRejected) {
        return dataResponse({
          disclaimer: PORTFOLIO_DISCLAIMER,
          note: "Account scope did not resolve — no holdings returned. See `warnings` for details.",
          totalHoldings: 0,
          reportingCurrency: reporting,
          warnings: accountWarnings,
          summary: {
            lifetimeCostBasisReporting: tagAmount(0, reporting, "reporting"),
            totalRealizedGainReporting: tagAmount(0, reporting, "reporting"),
            totalDividendsReporting: tagAmount(0, reporting, "reporting"),
            totalReturnReporting: tagAmount(0, reporting, "reporting"),
            totalReturnPctReporting: null,
          },
          holdings: [],
        });
      }

      // Issue #84: dividends classified by category_id, not the legacy
      // qty=0+amt>0 heuristic. Pass the user's Dividends category id (or
      // null if they have no such category) into the aggregator.
      const dividendsCategoryId = await resolveDividendsCategoryId(db, userId, dek);
      const metrics = await aggregateHoldings(db, userId, dek, { dividendsCategoryId });

      // Issue #86: SELECT ph.id so we can build an id-keyed phMap. Two
      // holdings sharing a display name (TFSA + RRSP) collide in a
      // name-keyed map; keying by id keeps them distinct.
      // Issue #123: SELECT ph.account_id so we can guard rows in the per-row
      // loop below when an account scope is active. The filter rides the
      // existing holding_accounts JOIN grain (issue #25); we don't add a new
      // join — just an extra WHERE predicate.
      // Stream D Phase 4: ph.name, ph.symbol, a.name dropped — read *_ct only.
      const phRaw = await q(db, sql`
        SELECT ph.id, ph.account_id, ph.name_ct, ph.symbol_ct, ph.currency,
               a.name_ct as account_name_ct
        FROM portfolio_holdings ph
        JOIN accounts a ON a.id = ph.account_id
        WHERE ph.user_id = ${userId}
          ${scopeAccountId != null ? sql`AND ph.account_id = ${scopeAccountId}` : sql``}
      `);
      const ph: Row[] = phRaw.map((p) => ({
        ...p,
        name: p.name_ct && dek ? decryptField(dek, p.name_ct) : null,
        symbol: p.symbol_ct && dek ? decryptField(dek, p.symbol_ct) : null,
        account_name: p.account_name_ct && dek ? decryptField(dek, p.account_name_ct) : null,
      }));
      const phMap = new Map<number, Row>(ph.map(p => [Number(p.id), p]));

      const symbolFilters = symbols?.length ? symbols.map(s => s.toLowerCase()) : null;
      // Track which filter entries matched at least one holding; unmatched
      // ones surface in the response as warnings.
      const matchedFilters = new Set<string>();
      // Issue #124: pre-tokenize each filter entry once. Empty/whitespace-only
      // entries (e.g. "()" tokenizes to []) would vacuously match every row
      // under `tokens.every(...)` — guard them here and let them surface as
      // unmatched warnings instead.
      const symbolTokens = symbolFilters
        ? symbolFilters.map(s => ({
            raw: s,
            tokens: s.split(/[\s()[\]]+/).filter(Boolean),
          }))
        : null;

      const today = new Date();
      // Issue #209 — threshold guard for `totalReturnPct`. Below this floor in
      // the holding's own currency, the return % is suppressed (set to null)
      // and a row warning surfaces the reason. Cash sleeves with $0.04 cost
      // basis used to overflow to `18,501,638.9%`; legitimate near-zero
      // positions (rounding dust on closed positions) get the same treatment.
      const PERCENT_FLOOR_NATIVE = 1.0;
      // Issue #209 — surfaced per row when the percentage is suppressed for
      // any reason (cash sleeve, cost basis below floor).
      type RowWarning = { holdingId: number | null; code: string; message: string };
      const rowWarnings: RowWarning[] = [];
      // Issue #209 — explicit status field so callers don't infer state from
      // null patterns on totalCostBasis/daysHeld/firstPurchaseDate.
      type HoldingStatus = "active" | "zero_position" | "cash_only" | "sold_out";
      type HoldingResult = {
        id: number | null;
        name: unknown; symbol: unknown; account: unknown; currency: string;
        status: HoldingStatus;
        quantity: number; avgCostPerShare: number | null; totalCostBasis: number | null;
        lifetimeCostBasis: number; realizedGain: number; dividendsReceived: number;
        totalReturn: number | null; totalReturnPct: number | null;
        firstPurchaseDate: unknown; daysHeld: number | null;
        avgCostPerShareTagged: ReturnType<typeof tagAmount> | null;
        lifetimeCostBasisTagged: ReturnType<typeof tagAmount>;
        lifetimeCostBasisReporting: ReturnType<typeof tagAmount>;
        realizedGainTagged: ReturnType<typeof tagAmount>;
        realizedGainReporting: ReturnType<typeof tagAmount>;
        dividendsReceivedTagged: ReturnType<typeof tagAmount>;
        dividendsReceivedReporting: ReturnType<typeof tagAmount>;
      };
      const results: HoldingResult[] = [];

      for (const m of metrics) {
        // Issue #86: look up the holding by FK id, not display name. Two
        // holdings sharing a name (TFSA + RRSP) collide in a name-keyed map
        // and silently merge into one row; an id-keyed map keeps them
        // distinct and ensures `account` reflects the right side of the pair.
        const info = m.holding_id != null ? phMap.get(Number(m.holding_id)) : undefined;
        // Issue #123: when an account scope is active, phMap only contains
        // matching-account holdings. metrics covers ALL user holdings, so
        // skip rows whose info is missing under that scope. Without a scope
        // we still tolerate missing info (defensive — an aggregator row
        // without a phMap match falls through to the existing null/empty
        // handling below).
        if (scopeAccountId != null && !info) continue;
        if (symbolTokens) {
          const name = String(m.name ?? "").toLowerCase();
          const sym = String(info?.symbol ?? "").toLowerCase();
          const acct = String(info?.account_name ?? "").toLowerCase();
          // Issue #124: AND-within-entry semantic. Build a single haystack
          // covering name + symbol + account, and require every token in a
          // filter entry to appear in it. Across entries the semantic is OR.
          // Full-string substring fast path stays for the cheap single-token
          // case. Skip empty-token entries (e.g. "()" → [tokens=[]]) so they
          // surface as warnings rather than vacuously matching every row.
          const haystack = `${name} ${sym} ${acct}`;
          const matched = symbolTokens.some(({ raw, tokens }) => {
            if (tokens.length === 0) return false;
            if (haystack.includes(raw)) {
              matchedFilters.add(raw);
              return true;
            }
            const hit = tokens.every(t => haystack.includes(t));
            if (hit) matchedFilters.add(raw);
            return hit;
          });
          if (!matched) continue;
        }
        const buyQty = Number(m.buy_qty ?? 0);
        const buyAmt = Number(m.buy_amount ?? 0);
        const sellQty = Number(m.sell_qty ?? 0);
        const sellAmt = Number(m.sell_amount ?? 0);
        const divs = Number(m.dividends ?? 0);
        // Position qty = UNSKIPPED net Σ(quantity) (aggregateHoldings'
        // `net_quantity`, accumulated for every row BEFORE the #128 cash-leg
        // skip). Using buyQty - sellQty here is skip-aware and drops a cash
        // sleeve's own buy_cash_leg/sell_cash_leg from its balance (showed Cash
        // USD at 700k when the true balance was 0). For non-cash-sleeve holdings
        // net_quantity == buyQty - sellQty (no-op). Mirrors
        // get_portfolio_performance_v2 + holdings-value.ts. avgCost/realizedGain
        // stay on the skip-aware buy/sell tallies.
        const remainingQty = Number(m.net_quantity ?? (buyQty - sellQty));
        const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
        const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
        const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
        const totalReturn = realizedGain + divs; // unrealized excluded (no live prices in MCP)
        const fpDate = m.first_purchase ?? null;
        const daysHeld = fpDate ? Math.floor((today.getTime() - new Date(String(fpDate)).getTime()) / 86400000) : null;
        const ccy = String(info?.currency ?? "CAD");
        const fx = await fxFor(ccy);

        // Issue #209 — cash-sleeve detection. Cash sleeves are
        // `name='Cash', symbol=NULL/empty` per the investment-account
        // constraint (CLAUDE.md). A $9.90 dividend posted to a $0-cost cash
        // sleeve must NOT report `100%+ return`. Detection guards on `info?`
        // (when DEK is missing the symbol/name decrypt to null and detection
        // silently fails — accepted soft-fallback per CLAUDE.md "Read vs
        // write auth guards"; without the DEK every other display field is
        // also blank).
        const symbolStr = String(info?.symbol ?? "").trim();
        const nameLower = String(m.name ?? "").trim().toLowerCase();
        const isCashSleeve = symbolStr === "" && nameLower === "cash";

        // Issue #209 — derive explicit status. Clients should branch on this
        // field, not on null patterns of totalCostBasis/daysHeld.
        const status: HoldingStatus = isCashSleeve
          ? "cash_only"
          : remainingQty > 0
            ? "active"
            : buyQty > 0 && remainingQty <= 0
              ? "sold_out"
              : "zero_position";

        // Issue #209 — threshold-guard `totalReturnPct`. Cash sleeves never
        // get a percentage. Below the native-currency floor, suppress and
        // surface a row warning so the LLM can explain the suppression.
        let totalReturnPct: number | null;
        if (isCashSleeve) {
          totalReturnPct = null;
          rowWarnings.push({
            holdingId: m.holding_id ?? null,
            code: "cash_sleeve_no_return_pct",
            message: "Cash sleeve — return % not meaningful (no cost basis convention).",
          });
        } else if (buyAmt >= PERCENT_FLOOR_NATIVE) {
          totalReturnPct = (totalReturn / buyAmt) * 100;
        } else {
          totalReturnPct = null;
          if (buyAmt > 0) {
            rowWarnings.push({
              holdingId: m.holding_id ?? null,
              code: "cost_basis_too_small",
              message: `Cost basis below ${PERCENT_FLOOR_NATIVE} ${ccy} — return % suppressed (would otherwise overflow).`,
            });
          }
        }

        // Issue #208 — round at the response boundary using the helper so
        // IEEE-754 noise (`-3.6e-11`-class drift, `5598.589999990002`-class
        // leaks) is crushed everywhere these fields land. The aggregator
        // (`accumulate()`) keeps full precision internally; we only round
        // here.
        results.push({
          // FK to portfolio_holdings.id — pass this as portfolioHoldingId on
          // record_transaction / update_transaction to bind a transaction to
          // this position. Always set post-Phase-6 (orphan-fallback path is gone).
          id: m.holding_id ?? null,
          name: m.name,
          symbol: info?.symbol ?? null,
          account: info?.account_name ?? null,
          currency: ccy,
          status,
          quantity: Math.round(remainingQty * 10000) / 10000,
          avgCostPerShare: avgCost ? roundMoney(avgCost, ccy) : null,
          avgCostPerShareTagged: avgCost ? tagAmount(avgCost, ccy, "account") : null,
          totalCostBasis: costBasis ? roundMoney(costBasis, ccy) : null,
          lifetimeCostBasis: roundMoney(buyAmt, ccy),
          lifetimeCostBasisTagged: tagAmount(buyAmt, ccy, "account"),
          lifetimeCostBasisReporting: tagAmount(buyAmt * fx, reporting, "reporting"),
          realizedGain: roundMoney(realizedGain, ccy),
          realizedGainTagged: tagAmount(realizedGain, ccy, "account"),
          realizedGainReporting: tagAmount(realizedGain * fx, reporting, "reporting"),
          dividendsReceived: roundMoney(divs, ccy),
          dividendsReceivedTagged: tagAmount(divs, ccy, "account"),
          dividendsReceivedReporting: tagAmount(divs * fx, reporting, "reporting"),
          totalReturn: roundMoney(totalReturn, ccy),
          totalReturnPct: totalReturnPct !== null ? Math.round(totalReturnPct * 100) / 100 : null,
          firstPurchaseDate: fpDate,
          daysHeld,
        });
      }

      results.sort((a, b) => (b.lifetimeCostBasis ?? 0) - (a.lifetimeCostBasis ?? 0));

      // Issue #209 — dropped mixed-currency raw sums from the summary. The
      // pre-209 code published `totalCostBasis` / `lifetimeCostBasis` /
      // `totalRealizedGain` / `totalDividends` / `totalReturn` /
      // `totalReturnPct` as raw arithmetic sums of per-row values that are
      // each in their own currency — the result is mathematically
      // meaningless ("615648.4 USD-ish + CAD-ish"). The `*Reporting` siblings
      // (FX-converted into the user's reporting currency) are the canonical
      // totals and are now the only summary money fields.
      let totalLifetimeReporting = 0;
      let totalRealizedReporting = 0;
      let totalDivsReporting = 0;
      for (const r of results) {
        // Cash sleeves contribute $0 cost basis to the reporting sum (they
        // hold cash, not invested capital) — keeping their per-row inputs in
        // would understate the "total return %" denominator and inflate the
        // numerator with dividends-on-cash. Realized gain / dividends from
        // genuine holdings stay in.
        if (r.status === "cash_only") {
          totalRealizedReporting += r.realizedGainReporting.amount;
          totalDivsReporting += r.dividendsReceivedReporting.amount;
          continue;
        }
        totalLifetimeReporting += r.lifetimeCostBasisReporting.amount;
        totalRealizedReporting += r.realizedGainReporting.amount;
        totalDivsReporting += r.dividendsReceivedReporting.amount;
      }
      const totalReturnReporting = totalRealizedReporting + totalDivsReporting;

      // Issue #209 — threshold guard for the summary `totalReturnPctReporting`.
      // Below this floor in reporting currency, the percentage is suppressed
      // (set to null) and a top-level warning surfaces the reason.
      const PERCENT_FLOOR_REPORTING = 10;
      const summaryWarnings: string[] = [];
      let totalReturnPctReporting: number | null;
      if (totalLifetimeReporting >= PERCENT_FLOOR_REPORTING) {
        totalReturnPctReporting = Math.round((totalReturnReporting / totalLifetimeReporting) * 10000) / 100;
      } else {
        totalReturnPctReporting = null;
        if (totalLifetimeReporting > 0) {
          summaryWarnings.push(
            `Aggregate cost basis below ${PERCENT_FLOOR_REPORTING} ${reporting} — return % suppressed (would otherwise overflow).`
          );
        }
      }

      // Issue #86: surface unmatched `symbols` filter entries as warnings so
      // the caller can correct typos/missing positions instead of silently
      // getting an empty result.
      // Issue #123: merge any account-scope warnings (e.g. account_id not
      // owned, or low-confidence fuzzy account match) into the same array.
      // Issue #209: include the summary-level threshold-guard warning here.
      // The contract is strings only — no objects — to keep callers simple;
      // per-row warnings live on the response's `rowWarnings[]` array.
      const warnings: string[] = [
        ...accountWarnings,
        ...summaryWarnings,
        ...(symbolFilters
          ? symbols!.filter(s => !matchedFilters.has(s.toLowerCase()))
              .map(s => `${s}: no matching holding found`)
          : []),
      ];

      return dataResponse({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "Per-holding marketValue and unrealizedGain require live prices and are not surfaced here — use the portfolio page for full per-holding metrics. (Account-LEVEL market value IS available via get_account_balances / get_net_worth on OAuth/built-in-chat connections.) Results are per-holdingId — two holdings sharing a name across accounts return as separate rows. Per-row amounts stay in each holding's native currency; summary aggregates are converted to `reportingCurrency`. Cash-sleeve holdings (name='Cash', symbol=NULL) appear in `holdings[]` with `status: 'cash_only'` and `totalReturnPct: null`.",
        totalHoldings: results.length,
        reportingCurrency: reporting,
        warnings,
        rowWarnings,
        // Issue #209 — only `*Reporting` siblings remain. These are the
        // canonical totals (FX-converted into the user's reporting currency).
        // Cash-sleeve `lifetimeCostBasis` is excluded from the denominator.
        summary: {
          lifetimeCostBasisReporting: tagAmount(roundMoney(totalLifetimeReporting, reporting), reporting, "reporting"),
          totalRealizedGainReporting: tagAmount(roundMoney(totalRealizedReporting, reporting), reporting, "reporting"),
          totalDividendsReporting: tagAmount(roundMoney(totalDivsReporting, reporting), reporting, "reporting"),
          totalReturnReporting: tagAmount(roundMoney(totalReturnReporting, reporting), reporting, "reporting"),
          totalReturnPctReporting,
        },
        holdings: results,
      });
    }
  );


  // ── get_portfolio_performance ──────────────────────────────────────────────
  server.tool(
    "get_portfolio_performance",
    "Portfolio performance with avg-cost method: realized P&L, dividends, total return, days held per holding. Returns one row per `holdingId` (two holdings sharing a display name come through as separate rows). Per-row amounts stay in each holding's own (account) currency; the response includes the resolved reportingCurrency for context.",
    {
      period: z.enum(["1m", "3m", "6m", "1y", "all"]).optional().describe("Lookback period (default: all)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Returned in the response as context for cross-currency holdings."),
    },
    async ({ period, reportingCurrency }) => {
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const cutoff: Record<string, string> = {
        "1m": new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
        "3m": new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0],
        "6m": new Date(Date.now() - 180 * 86400000).toISOString().split("T")[0],
        "1y": new Date(Date.now() - 365 * 86400000).toISOString().split("T")[0],
        "all": "1900-01-01",
      };
      const since = cutoff[period ?? "all"];
      const today = new Date();

      // Issue #84: dividends classified by category_id (see aggregateHoldings).
      const dividendsCategoryId = await resolveDividendsCategoryId(db, userId, dek);
      const perf = await aggregateHoldings(db, userId, dek, { since, dividendsCategoryId });

      // Issue #209 — load portfolio_holdings.symbol_ct so we can detect cash
      // sleeves (`name='Cash', symbol=NULL/empty`) and suppress percentage
      // overflow on rows like a $9.90 dividend posted to a $0-cost cash leg.
      // Without the symbol we can't disambiguate a real holding called "Cash"
      // from the auto-created cash sleeve.
      const phRaw = await q(db, sql`
        SELECT id, symbol_ct FROM portfolio_holdings WHERE user_id = ${userId}
      `);
      const symbolByHoldingId = new Map<number, string>();
      for (const p of phRaw) {
        const sym = p.symbol_ct && dek
          ? (() => { try { return decryptField(dek, String(p.symbol_ct)) ?? ""; } catch { return ""; } })()
          : "";
        symbolByHoldingId.set(Number(p.id), String(sym ?? "").trim());
      }

      // Issue #209 — threshold guard for `*Pct` overflow. Below this floor in
      // the holding's own currency the percentage is suppressed (set to null)
      // so a $0.04 cost-basis row stops emitting `18,501,638.9%`.
      const PERCENT_FLOOR_NATIVE = 1.0;
      // Issue #209 — surfaced per row when the percentage is suppressed.
      type PerfRowWarning = { holdingId: number | null; code: string; message: string };
      const perfRowWarnings: PerfRowWarning[] = [];
      // Issue #209 — explicit status field, mirrors get_portfolio_analysis.
      type PerfHoldingStatus = "active" | "zero_position" | "cash_only" | "sold_out";

      // Issue #209 — FX cache so we can roll up a `*Reporting` summary in
      // the user's reporting currency (no more raw mixed-currency sums).
      const todayStr = new Date().toISOString().split("T")[0];
      const fxCache = new Map<string, number>();
      const fxFor = async (ccy: string): Promise<number> => {
        const k = (ccy || reporting).toUpperCase();
        if (fxCache.has(k)) return fxCache.get(k)!;
        const r = await getRate(k, reporting, todayStr, userId);
        fxCache.set(k, r);
        return r;
      };

      const results: Array<{
        holdingId: number | null;
        holding: unknown;
        status: PerfHoldingStatus;
        txCount: number;
        quantity: number;
        lifetimeCostBasis: number;
        lifetimeCostBasisReporting: ReturnType<typeof tagAmount>;
        currentCostBasis: number | null;
        avgCostPerShare: number | null;
        realizedGain: number;
        realizedGainReporting: ReturnType<typeof tagAmount>;
        realizedGainPct: number | null;
        dividendsReceived: number;
        dividendsReceivedReporting: ReturnType<typeof tagAmount>;
        totalReturn: number;
        totalReturnReporting: ReturnType<typeof tagAmount>;
        totalReturnPct: number | null;
        firstPurchase: unknown;
        lastActivity: unknown;
        daysHeld: number | null;
      }> = [];
      for (const p of perf) {
        const buyQty = Number(p.buy_qty ?? 0);
        const buyAmt = Number(p.buy_amount ?? 0);
        const sellQty = Number(p.sell_qty ?? 0);
        const sellAmt = Number(p.sell_amount ?? 0);
        const divs = Number(p.dividends ?? 0);
        const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
        const remainingQty = Number(p.net_quantity ?? 0);
        const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
        const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
        const totalReturn = realizedGain + divs;
        const fpDate = p.first_purchase ?? null;
        const daysHeld = fpDate ? Math.floor((today.getTime() - new Date(String(fpDate)).getTime()) / 86400000) : null;
        // Issue #208 — per-row money fields stay in the holding's own
        // currency; round at this boundary, not in `aggregateHoldings`.
        const rowCcy = String(p.currency ?? reporting);
        const fx = await fxFor(rowCcy);

        // Issue #209 — cash-sleeve detection via symbol map. Same rule as
        // get_portfolio_analysis: `symbol IS NULL/empty AND name='cash'` (case-
        // insensitive). When DEK is missing the symbol decrypts to empty and
        // detection silently fails — accepted soft-fallback per CLAUDE.md.
        const symbolStr = p.holding_id != null
          ? (symbolByHoldingId.get(Number(p.holding_id)) ?? "")
          : "";
        const nameLower = String(p.name ?? "").trim().toLowerCase();
        const isCashSleeve = symbolStr === "" && nameLower === "cash";

        const status: PerfHoldingStatus = isCashSleeve
          ? "cash_only"
          : remainingQty > 0
            ? "active"
            : buyQty > 0 && remainingQty <= 0
              ? "sold_out"
              : "zero_position";

        // Issue #209 — threshold-guard both percentages and skip cash sleeves.
        let realizedGainPct: number | null;
        let totalReturnPct: number | null;
        if (isCashSleeve) {
          realizedGainPct = null;
          totalReturnPct = null;
          perfRowWarnings.push({
            holdingId: p.holding_id ?? null,
            code: "cash_sleeve_no_return_pct",
            message: "Cash sleeve — return % not meaningful (no cost basis convention).",
          });
        } else if (buyAmt >= PERCENT_FLOOR_NATIVE) {
          realizedGainPct = Math.round((realizedGain / buyAmt) * 10000) / 100;
          totalReturnPct = Math.round((totalReturn / buyAmt) * 10000) / 100;
        } else {
          realizedGainPct = null;
          totalReturnPct = null;
          if (buyAmt > 0) {
            perfRowWarnings.push({
              holdingId: p.holding_id ?? null,
              code: "cost_basis_too_small",
              message: `Cost basis below ${PERCENT_FLOOR_NATIVE} ${rowCcy} — return % suppressed (would otherwise overflow).`,
            });
          }
        }

        results.push({
          // Issue #86: surface the FK id so callers can disambiguate
          // same-name holdings (e.g. VUN.TO in TFSA vs RRSP).
          holdingId: p.holding_id ?? null,
          holding: p.name,
          status,
          txCount: Number(p.tx_count),
          quantity: Math.round(remainingQty * 10000) / 10000,
          lifetimeCostBasis: roundMoney(buyAmt, rowCcy),
          lifetimeCostBasisReporting: tagAmount(buyAmt * fx, reporting, "reporting"),
          currentCostBasis: costBasis ? roundMoney(costBasis, rowCcy) : null,
          avgCostPerShare: avgCost ? roundMoney(avgCost, rowCcy) : null,
          realizedGain: roundMoney(realizedGain, rowCcy),
          realizedGainReporting: tagAmount(realizedGain * fx, reporting, "reporting"),
          realizedGainPct,
          dividendsReceived: roundMoney(divs, rowCcy),
          dividendsReceivedReporting: tagAmount(divs * fx, reporting, "reporting"),
          totalReturn: roundMoney(totalReturn, rowCcy),
          totalReturnReporting: tagAmount(totalReturn * fx, reporting, "reporting"),
          totalReturnPct,
          firstPurchase: fpDate,
          lastActivity: p.last_activity,
          daysHeld,
        });
      }

      // Issue #209 — drop mixed-currency raw sums; only `*Reporting` siblings
      // remain in summary. Cash sleeves contribute realized/dividend amounts
      // (still real money) but $0 cost basis, mirroring get_portfolio_analysis.
      let totalLifetimeReporting = 0;
      let totalRealizedReporting = 0;
      let totalDivsReporting = 0;
      for (const r of results) {
        if (r.status !== "cash_only") {
          totalLifetimeReporting += r.lifetimeCostBasisReporting.amount;
        }
        totalRealizedReporting += r.realizedGainReporting.amount;
        totalDivsReporting += r.dividendsReceivedReporting.amount;
      }
      const totalReturnReporting = totalRealizedReporting + totalDivsReporting;

      // Issue #209 — threshold guard for the summary aggregate. Mirrors
      // get_portfolio_analysis (10 reporting-currency units).
      const PERCENT_FLOOR_REPORTING = 10;
      const summaryWarnings: string[] = [];
      let totalReturnPctReporting: number | null;
      if (totalLifetimeReporting >= PERCENT_FLOOR_REPORTING) {
        totalReturnPctReporting = Math.round((totalReturnReporting / totalLifetimeReporting) * 10000) / 100;
      } else {
        totalReturnPctReporting = null;
        if (totalLifetimeReporting > 0) {
          summaryWarnings.push(
            `Aggregate cost basis below ${PERCENT_FLOOR_REPORTING} ${reporting} — return % suppressed (would otherwise overflow).`
          );
        }
      }

      return dataResponse({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "unrealizedGain requires live prices. Use the portfolio page for full metrics. Per-row amounts stay in each holding's native currency; summary aggregates are converted to `reportingCurrency`. Cash-sleeve holdings (name='Cash', symbol=NULL) appear with `status: 'cash_only'` and percentages suppressed.",
        period: period ?? "all",
        since,
        reportingCurrency: reporting,
        warnings: summaryWarnings,
        rowWarnings: perfRowWarnings,
        // Issue #209 — only `*Reporting` siblings remain. Cash-sleeve
        // `lifetimeCostBasis` is excluded from the denominator.
        summary: {
          holdings: results.length,
          lifetimeCostBasisReporting: tagAmount(roundMoney(totalLifetimeReporting, reporting), reporting, "reporting"),
          totalRealizedGainReporting: tagAmount(roundMoney(totalRealizedReporting, reporting), reporting, "reporting"),
          totalDividendsReporting: tagAmount(roundMoney(totalDivsReporting, reporting), reporting, "reporting"),
          totalReturnReporting: tagAmount(roundMoney(totalReturnReporting, reporting), reporting, "reporting"),
          totalReturnPctReporting,
        },
        holdings: results,
      });
    }
  );


  // ── analyze_holding ────────────────────────────────────────────────────────
  server.tool(
    "analyze_holding",
    "Deep-dive on a single holding: avg cost, realized gain, dividends, days held, full transaction history. Per-row amounts stay in the holding's account currency; aggregates also surface in reportingCurrency (defaults to user's display currency). When `symbol` substring-matches multiple holdings sharing the same name (TFSA + RRSP), pass `holdingId` to scope the analysis to a single position; otherwise the response includes an `ambiguous` array listing every candidate's `{holdingId, name, symbol, account}` and the caller must pick one.",
    {
      symbol: z.string().optional().describe("Holding name or symbol (fuzzy matched). Required when `holdingId` is omitted."),
      holdingId: z.number().int().optional().describe("Filter to this exact portfolio_holdings.id — bypasses fuzzy matching. Use this when `symbol` matches multiple positions sharing the same name (resolves the ambiguity)."),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ symbol, holdingId, reportingCurrency }) => {
      if (!symbol && holdingId == null) {
        return err("analyze_holding requires either `symbol` or `holdingId`");
      }
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const todayStr = new Date().toISOString().split("T")[0];
      const lo = (symbol ?? "").toLowerCase();
      // Fetch every FK-bound transaction for the user, JOINing
      // holding_accounts (Section G) on (holding_id, account_id) so the
      // (holding, account) pair is the join grain, plus portfolio_holdings
      // for the (encrypted) display name + symbol. Phase 6 (2026-04-29)
      // dropped the legacy t.portfolio_holding text column; the FK is now
      // the sole source of truth. CLAUDE.md "Portfolio aggregator" — qty>0
      // = buy regardless of amount sign (preserved in the loop below).
      // Issue #84: SELECT t.category_id so the dividend classifier can match
      // on the user's Dividends category id instead of the legacy
      // qty=0+amt>0 heuristic.
      const dividendsCategoryId = await resolveDividendsCategoryId(db, userId, dek);
      // Issue #96: LEFT JOIN to cash-leg sibling (multi-currency trade
      // pair). cash.entered_amount is the broker's actual settlement value
      // in cash.entered_currency; we substitute it for t.amount on a paired
      // buy row in the loop below. cash.id is null for unpaired rows
      // (legacy / single-currency / non-buy) — fallback path.
      // Issue #128: SELECT t.trade_link_id so the per-row loop below can skip
      // paired cash-leg rows from the realized-gain sell branch.
      // Issue #129: SELECT ph.currency, t.entered_amount, t.entered_currency,
      // and the cash leg's entered_*; the per-row loop normalizes amounts
      // into the holding's own currency. Without this, cross-currency
      // holdings (USD ETF inside CAD account) summed amounts in account
      // currency and labeled them holding currency, producing inflated
      // numbers and a downstream double-FX bug in reporting.
      // Stream D Phase 4: ph.name, ph.symbol, a.name dropped — read *_ct only.
      // Phase 2 (2026-05-26): SELECT t.kind so the per-row loop can skip
      // `buy_cash_leg`/`sell_cash_leg` rows in the realized-gain calc.
      const rawTxns = await q(db, sql`
        SELECT t.id, t.date, t.amount, t.quantity, t.payee, t.note, t.tags,
               t.portfolio_holding_id, t.category_id, t.trade_link_id, t.kind,
               t.entered_amount, t.entered_currency, t.currency AS row_currency,
               ph.name_ct as ph_name_ct,
               ph.symbol_ct as ph_symbol_ct,
               ph.currency as holding_currency,
               a.name_ct as account_name_ct, a.currency,
               cash.amount AS cash_amount, cash.id AS cash_id,
               cash.entered_amount AS cash_entered_amount,
               cash.entered_currency AS cash_entered_currency,
               cash.currency AS cash_row_currency
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        INNER JOIN holding_accounts ha
          ON ha.holding_id = t.portfolio_holding_id
         AND ha.account_id = t.account_id
         AND ha.user_id = ${userId}
        LEFT JOIN portfolio_holdings ph ON ph.id = t.portfolio_holding_id
        LEFT JOIN transactions cash
          ON cash.user_id = ${userId}
         AND cash.trade_link_id IS NOT NULL
         AND cash.trade_link_id = t.trade_link_id
         AND cash.id <> t.id
         AND COALESCE(cash.quantity, 0) = 0
        WHERE t.user_id = ${userId}
          AND t.portfolio_holding_id IS NOT NULL
        ORDER BY t.date ASC
      `);

      const decryptedAll: Row[] = rawTxns.map((t) => {
        // Stream D Phase 4: only ciphertext sources remain. Decrypt or null.
        let ph: string | null = null;
        if (t.ph_name_ct && dek) {
          try { ph = decryptField(dek, String(t.ph_name_ct)) ?? null; } catch { ph = null; }
        }
        let ph_sym: string | null = null;
        if (t.ph_symbol_ct && dek) {
          try { ph_sym = decryptField(dek, String(t.ph_symbol_ct)) ?? null; } catch { ph_sym = null; }
        }
        const pay = dek ? decryptField(dek, String(t.payee ?? "")) : t.payee;
        const nt = dek ? decryptField(dek, String(t.note ?? "")) : t.note;
        const tg = dek ? decryptField(dek, String(t.tags ?? "")) : t.tags;
        const accName = t.account_name_ct && dek ? decryptField(dek, String(t.account_name_ct)) : null;
        return { ...t, portfolio_holding: ph, ph_symbol: ph_sym, payee: pay, note: nt, tags: tg, account_name: accName };
      });
      // Issue #86: when `holdingId` is provided, short-circuit the fuzzy
      // substring filter and scope strictly to that FK id. Otherwise apply
      // the legacy substring-on-name + payee + exact-symbol rule, then check
      // whether the match spans multiple holding ids — if so, surface them
      // in an `ambiguous` array so the caller can disambiguate by passing
      // `holdingId` back.
      const txns = holdingId != null
        ? decryptedAll.filter((t) => Number(t.portfolio_holding_id) === holdingId)
        : decryptedAll.filter((t) => {
            const ph = String(t.portfolio_holding ?? "").toLowerCase();
            const sym = String(t.ph_symbol ?? "").toLowerCase();
            const pay = String(t.payee ?? "").toLowerCase();
            // Symbol gets exact-equality preference (tickers are short and prone
            // to spurious substring hits — "GE" inside "ORANGE" etc.). Name and
            // payee retain substring matching for the long-string ergonomics.
            return ph.includes(lo) || pay.includes(lo) || sym === lo;
          });

      if (!txns.length) {
        return err(holdingId != null
          ? `No transactions found for holdingId=${holdingId}`
          : `No transactions found for holding matching "${symbol}"`);
      }

      // Issue #86: detect cross-holding ambiguity. When the substring match
      // spans multiple distinct holding ids (e.g. "VUN" matching VUN.TO in
      // both TFSA and RRSP), return the candidate list and require the
      // caller to pick one via `holdingId`. Skipped when `holdingId` was
      // supplied (the filter is already strict).
      if (holdingId == null) {
        const distinctIds = new Set<number>();
        for (const t of txns) {
          if (t.portfolio_holding_id != null) distinctIds.add(Number(t.portfolio_holding_id));
        }
        if (distinctIds.size > 1) {
          const ambiguous: Array<{ holdingId: number; name: string | null; symbol: string | null; account: string | null }> = [];
          const seen = new Set<number>();
          for (const t of txns) {
            const hid = t.portfolio_holding_id != null ? Number(t.portfolio_holding_id) : null;
            if (hid == null || seen.has(hid)) continue;
            seen.add(hid);
            ambiguous.push({
              holdingId: hid,
              name: (t.portfolio_holding ?? null) as string | null,
              symbol: (t.ph_symbol ?? null) as string | null,
              account: (t.account_name ?? null) as string | null,
            });
          }
          return dataResponse({
            disclaimer: PORTFOLIO_DISCLAIMER,
            ambiguous,
            note: `Substring "${symbol}" matched ${ambiguous.length} distinct holdings. Re-call analyze_holding with one of these holdingId values to scope the analysis.`,
          });
        }
      }

      const holdingName = txns[0].portfolio_holding || txns[0].payee;
      // Pull the holding's FK id so the agent can pass it back on
      // record_transaction / update_transaction. Prefer rows whose JOINed
      // holding name equals the chosen holdingName — payee-only matches
      // (e.g. "Huron Sale" payee on a non-investment cash row) could otherwise
      // surface a different holding's id and mislead the caller.
      // Issue #86: when holdingId was supplied, use it directly.
      const resolvedHoldingId: number | null = holdingId ??
        ((txns.find(
          (t) =>
            t.portfolio_holding_id != null &&
            String(t.portfolio_holding ?? "") === holdingName
        )?.portfolio_holding_id as number | undefined) ?? null);
      const today = new Date();

      // Issue #129: holding currency is sourced from `ph.currency` (the
      // JOINed portfolio_holdings currency), NOT `a.currency` (account
      // currency). Cross-currency holdings (e.g. USD ETF in a CAD account)
      // had their cost basis previously labeled with the account currency;
      // the fix re-labels with the actual holding currency AND normalizes
      // the per-row amount into that currency. Falls back to account
      // currency only if ph.currency is null (legacy data with broken FK).
      const holdingCurrency = String(
        txns[0]?.holding_currency ?? txns[0]?.currency ?? reporting
      ).toUpperCase();

      // Pre-resolve every (entered_currency → holding_currency) FX hop
      // into a synchronous cache.
      const fxCache = new Map<string, number>();
      const fxPair = (from: string, to: string) => `${from.toUpperCase()}->${to.toUpperCase()}`;
      const neededPairs = new Set<string>();
      for (const t of txns) {
        const enteredCcy = String(t.entered_currency ?? t.row_currency ?? t.currency ?? "").toUpperCase();
        if (enteredCcy && enteredCcy !== holdingCurrency) neededPairs.add(fxPair(enteredCcy, holdingCurrency));
        if (t.cash_id != null) {
          const cashCcy = String(t.cash_entered_currency ?? t.cash_row_currency ?? t.currency ?? "").toUpperCase();
          if (cashCcy && cashCcy !== holdingCurrency) neededPairs.add(fxPair(cashCcy, holdingCurrency));
        }
      }
      for (const key of neededPairs) {
        const [from, to] = key.split("->");
        fxCache.set(key, await getRate(from, to, todayStr, userId));
      }
      const fxLookup = (from: string, to: string): number => {
        const f = (from || "").toUpperCase();
        const t2 = (to || "").toUpperCase();
        if (!f || !t2 || f === t2) return 1;
        return fxCache.get(fxPair(f, t2)) ?? 1;
      };

      let buyQty = 0, buyAmt = 0, sellQty = 0, sellAmt = 0, divAmt = 0;
      // Position qty = UNSKIPPED net Σ(quantity), accumulated for EVERY row
      // (incl. paired cash legs). The #128 cash-leg skip below applies to the
      // buy/sell (realized-gain) tallies ONLY — using buyQty - sellQty for
      // position qty drops a cash sleeve's own buy_cash_leg/sell_cash_leg from
      // its balance. For non-cash-sleeve holdings netQty == buyQty - sellQty.
      let netQty = 0;
      const purchases: typeof txns = [];
      const sales: typeof txns = [];
      const dividends: typeof txns = [];

      // qty>0 = buy (handles Finlynq-native amt<0+qty>0 and WP convention
      // amt>0+qty>0). qty<0 = sell. The buy/sell branches come first so
      // dividend reinvestments (qty>0, amt<0, category=Dividends) still
      // count toward shares held.
      //
      // Issue #84: dividends are matched by category_id (the user's Dividends
      // category), not the legacy `qty=0 AND amt>0` heuristic. The heuristic
      // silently dropped dividend reinvestments and withholding-tax /
      // negative-correction rows. When the user has no Dividends category
      // (dividendsCategoryId == null), divAmt stays 0.
      //
      // Issue #129: every per-row amount is normalized into the holding's
      // own currency. entered_amount + entered_currency is the truth
      // source; falls back to amount + account-currency for un-backfilled
      // legacy rows. For paired buys (issue #96) the cash leg's
      // entered_amount/currency wins. The previous code summed amounts in
      // account currency and labeled them with the holding currency,
      // producing inflated cost basis on every cross-currency holding.
      for (const t of txns) {
        const qty = Number(t.quantity ?? 0);
        const amt = Number(t.amount);
        const catId = t.category_id != null ? Number(t.category_id) : null;
        const enteredCcy = String(t.entered_currency ?? t.row_currency ?? t.currency ?? "").toUpperCase();
        // Issue #128 (Phase 2 update, 2026-05-26): skip paired cash-leg
        // rows from BOTH buy- and sell-side. See accumulate() above for
        // rationale.
        const tradeLinkId = t.trade_link_id ?? null;
        const kind = (t.kind ?? null) as string | null;
        netQty += qty;
        const isPairedCashLeg =
          kind === "buy_cash_leg" || kind === "sell_cash_leg" ||
          (tradeLinkId != null && amt === 0);
        if (isPairedCashLeg) {
          // Skip — neither buy nor sell for realized-gain purposes.
        } else if (qty > 0) {
          // Issue #96: paired cash-leg cost basis when present.
          // Issue #129: prefer cash.entered_amount in cash.entered_currency,
          // FX-converted into holding currency; falls back to cash.amount in
          // the cash row's currency, then to the stock leg's
          // entered_amount/amount.
          let buyCostInHolding: number;
          if (t.cash_id != null) {
            const cashEnteredAmt = t.cash_entered_amount != null ? Number(t.cash_entered_amount) : NaN;
            const cashAmt = Number.isFinite(cashEnteredAmt) ? cashEnteredAmt : Number(t.cash_amount ?? 0);
            const cashCcy = String(t.cash_entered_currency ?? t.cash_row_currency ?? t.currency ?? "").toUpperCase();
            buyCostInHolding = Math.abs(cashAmt) * fxLookup(cashCcy, holdingCurrency);
          } else {
            const enteredAmt = t.entered_amount != null ? Number(t.entered_amount) : NaN;
            const buyCostInEntered = Number.isFinite(enteredAmt) ? Math.abs(enteredAmt) : Math.abs(amt);
            buyCostInHolding = buyCostInEntered * fxLookup(enteredCcy, holdingCurrency);
          }
          buyQty += qty; buyAmt += buyCostInHolding; purchases.push(t);
        } else if (qty < 0) {
          // Issue #129: sell amount in entered_currency, FX-converted.
          const enteredAmt = t.entered_amount != null ? Number(t.entered_amount) : NaN;
          const sellAmtInEntered = Number.isFinite(enteredAmt) ? Math.abs(enteredAmt) : Math.abs(amt);
          const sellAmtInHolding = sellAmtInEntered * fxLookup(enteredCcy, holdingCurrency);
          sellQty += Math.abs(qty); sellAmt += sellAmtInHolding; sales.push(t);
        }
        if (dividendsCategoryId !== null && catId === dividendsCategoryId) {
          // Issue #129: dividend amount in entered_currency, FX-converted.
          // Sign preserved (dividends contribute positive; withholding-
          // tax / corrections contribute negative — see issue #84).
          const enteredAmt = t.entered_amount != null ? Number(t.entered_amount) : NaN;
          const divInEntered = Number.isFinite(enteredAmt) ? enteredAmt : amt;
          divAmt += divInEntered * fxLookup(enteredCcy, holdingCurrency);
          dividends.push(t);
        }
      }

      const avgCost = buyQty > 0 ? buyAmt / buyQty : null;
      // Position qty = UNSKIPPED net Σ(quantity) — see netQty declaration above.
      // avgCost / realizedGain stay on the skip-aware buy/sell tallies.
      const remainingQty = netQty;
      const costBasis = avgCost !== null && remainingQty > 0 ? remainingQty * avgCost : null;
      const realizedGain = avgCost !== null ? sellAmt - (sellQty * avgCost) : 0;
      const totalReturn = realizedGain + divAmt; // no live price = no unrealized
      const firstDate = txns[0].date;
      const daysHeld = firstDate
        ? Math.floor((today.getTime() - new Date(String(firstDate)).getTime()) / 86400000)
        : null;

      const fxToReporting = await getRate(holdingCurrency, reporting, todayStr, userId);

      return dataResponse({
        disclaimer: PORTFOLIO_DISCLAIMER,
        note: "Per-holding unrealizedGain requires live prices and is not surfaced here. (Account-level market value IS available via get_account_balances / get_net_worth on OAuth/built-in-chat connections.)",
        // FK to portfolio_holdings.id — pass as portfolioHoldingId on
        // record_transaction / update_transaction to bind a transaction to
        // this position. Null when the matched rows are pure payee-fuzzy
        // hits with no FK yet (e.g. cash payee like "Huron Sale" with the
        // holding never bound).
        holdingId: resolvedHoldingId,
        holding: holdingName,
        currency: holdingCurrency,
        reportingCurrency: reporting,
        // Position — Issue #208 round at the response boundary.
        currentShares: Math.round(remainingQty * 10000) / 10000,
        avgCostPerShare: avgCost ? roundMoney(avgCost, holdingCurrency) : null,
        avgCostPerShareTagged: avgCost ? tagAmount(avgCost, holdingCurrency, "account") : null,
        currentCostBasis: costBasis ? roundMoney(costBasis, holdingCurrency) : null,
        currentCostBasisTagged: costBasis !== null ? tagAmount(costBasis, holdingCurrency, "account") : null,
        lifetimeCostBasis: roundMoney(buyAmt, holdingCurrency),
        lifetimeCostBasisTagged: tagAmount(buyAmt, holdingCurrency, "account"),
        lifetimeCostBasisReporting: tagAmount(buyAmt * fxToReporting, reporting, "reporting"),
        // Performance
        realizedGain: roundMoney(realizedGain, holdingCurrency),
        realizedGainTagged: tagAmount(realizedGain, holdingCurrency, "account"),
        realizedGainReporting: tagAmount(realizedGain * fxToReporting, reporting, "reporting"),
        realizedGainPct: buyAmt > 0 ? Math.round((realizedGain / buyAmt) * 10000) / 100 : null,
        dividendsReceived: roundMoney(divAmt, holdingCurrency),
        dividendsReceivedTagged: tagAmount(divAmt, holdingCurrency, "account"),
        dividendsReceivedReporting: tagAmount(divAmt * fxToReporting, reporting, "reporting"),
        totalReturn: roundMoney(totalReturn, holdingCurrency),
        totalReturnTagged: tagAmount(totalReturn, holdingCurrency, "account"),
        totalReturnReporting: tagAmount(totalReturn * fxToReporting, reporting, "reporting"),
        totalReturnPct: buyAmt > 0 ? Math.round((totalReturn / buyAmt) * 10000) / 100 : null,
        // Time
        firstPurchaseDate: firstDate,
        lastActivity: txns[txns.length - 1].date,
        daysHeld,
        // Transaction counts
        purchases: purchases.length,
        sales: sales.length,
        dividendPayments: dividends.length,
        totalTransactions: txns.length,
        // Recent history — Issue #208 round per-row amount.
        recentTransactions: txns.slice(-8).map(t => {
          const txCcy = String(t.currency ?? holdingCurrency);
          const rawAmt = Number(t.amount);
          return {
            date: t.date,
            amount: roundMoney(rawAmt, txCcy),
            quantity: t.quantity,
            currency: txCcy,
            amountTagged: tagAmount(rawAmt, txCcy, "account"),
            type: Number(t.quantity ?? 0) > 0
              ? "buy"
              : Number(t.quantity ?? 0) < 0
                ? "sell"
                : rawAmt > 0 ? "dividend" : "other",
            account: t.account_name,
            note: t.note || undefined,
          };
        }),
      });
    }
  );


  // ── trace_holding_quantity ─────────────────────────────────────────────────
  server.tool(
    "trace_holding_quantity",
    "Per-transaction quantity contributions for a single holding, with running sum. Diagnostic tool for investigating quantity discrepancies (e.g. brokerage statement says 79 shares but the aggregator reports 86 — list every contributing leg to find the extra rows). Read-only. JOINs through `holding_accounts` (issue #25) so the rows match what the four portfolio aggregators see; rows whose `(holding_id, account_id)` pair is missing from `holding_accounts` are OMITTED (they're invisible to the aggregators too — surface the gap via the `unjoinedTransactionCount` field). Matches the `analyze_holding` resolution semantics: `holdingId` is preferred when present (bypasses fuzzy matching); when only `symbol` is given and it spans multiple holdings the response surfaces an `ambiguous` candidate list.",
    {
      symbol: z.string().optional().describe("Holding name or symbol (fuzzy matched). Required when `holdingId` is omitted."),
      holdingId: z.number().int().optional().describe("Filter to this exact portfolio_holdings.id — bypasses fuzzy matching."),
    },
    async ({ symbol, holdingId }) => {
      if (!symbol && holdingId == null) {
        return err("trace_holding_quantity requires either `symbol` or `holdingId`");
      }
      const lo = (symbol ?? "").toLowerCase();
      // Resolve the holding id when only `symbol` was supplied.
      // Issue #99: same ambiguity handling as analyze_holding — when the
      // substring spans multiple distinct holding ids, return the candidate
      // list rather than averaging across them.
      let resolvedHoldingId: number | null = holdingId ?? null;
      if (resolvedHoldingId == null) {
        // Stream D Phase 4: name + symbol plaintext columns dropped.
        const candidatesRaw = await q(db, sql`
          SELECT id, name_ct, symbol_ct, account_id
          FROM portfolio_holdings
          WHERE user_id = ${userId}
        `);
        const candidates: Row[] = decryptNameish(candidatesRaw, dek).map((c: Row): Row => {
          let sym: string | null = null;
          if (c.symbol_ct && dek) {
            try { sym = decryptField(dek, String(c.symbol_ct)) ?? null; } catch { sym = null; }
          }
          return { ...c, symbol_decrypted: sym };
        });
        const matches: Row[] = candidates.filter((c: Row) => {
          const n = String(c.name ?? "").toLowerCase();
          const s = String(c.symbol_decrypted ?? "").toLowerCase();
          // Symbol gets exact-equality preference; name keeps substring.
          return n.includes(lo) || s === lo;
        });
        if (!matches.length) {
          return err(`No holding found matching "${symbol}"`);
        }
        const distinctIds = new Set<number>(matches.map((m) => Number(m.id)));
        if (distinctIds.size > 1) {
          // Pull account name for each candidate so the caller can disambiguate.
          const ids = [...distinctIds];
          // Stream D Phase 4 — plaintext name dropped.
          const accountsRaw = await q(db, sql`
            SELECT id, name_ct FROM accounts WHERE user_id = ${userId}
          `);
          const accountsDec = decryptNameish(accountsRaw, dek);
          const accountNameById = new Map<number, string>();
          for (const a of accountsDec) accountNameById.set(Number(a.id), String(a.name ?? ""));
          const ambiguous = ids.map((id) => {
            const m = matches.find((x: Row) => Number(x.id) === id)!;
            return {
              holdingId: id,
              name: (m.name ?? null) as string | null,
              symbol: (m.symbol_decrypted ?? null) as string | null,
              account: accountNameById.get(Number(m.account_id)) ?? null,
            };
          });
          return dataResponse({
            ambiguous,
            note: `Substring "${symbol}" matched ${ambiguous.length} distinct holdings. Re-call trace_holding_quantity with one of these holdingId values.`,
          });
        }
        resolvedHoldingId = Number(matches[0].id);
      }

      // Issue #99: count transactions that reference this holding but whose
      // (holding_id, account_id) pair is NOT in holding_accounts — those rows
      // are invisible to the four aggregators (issue #25's INNER JOIN through
      // holding_accounts) and the discrepancy is exactly what users hit when
      // they ask "why does the statement say 79 but Finlynq says 86?"
      const unjoinedRows = await q(db, sql`
        SELECT COUNT(*) AS cnt
        FROM transactions t
        WHERE t.user_id = ${userId}
          AND t.portfolio_holding_id = ${resolvedHoldingId}
          AND NOT EXISTS (
            SELECT 1 FROM holding_accounts ha
            WHERE ha.user_id = ${userId}
              AND ha.holding_id = t.portfolio_holding_id
              AND ha.account_id = t.account_id
          )
      `);
      const unjoinedTransactionCount = Number(unjoinedRows[0]?.cnt ?? 0);

      // Pull every contributing leg via the same JOIN the aggregators use.
      // Stream D Phase 4: a.name dropped — read a.name_ct only.
      const legsRaw = await q(db, sql`
        SELECT t.id, t.date, t.account_id, t.quantity, t.amount, t.source,
               a.name_ct AS account_name_ct,
               t.payee
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        INNER JOIN holding_accounts ha
          ON ha.holding_id = t.portfolio_holding_id
         AND ha.account_id = t.account_id
         AND ha.user_id = ${userId}
        WHERE t.user_id = ${userId}
          AND t.portfolio_holding_id = ${resolvedHoldingId}
        ORDER BY t.date ASC, t.id ASC
      `);

      let runningSum = 0;
      const legs = legsRaw.map((row) => {
        const qty = Number(row.quantity ?? 0);
        runningSum += qty;
        const accName = row.account_name_ct && dek
          ? (decryptField(dek, String(row.account_name_ct)) ?? row.account_name)
          : row.account_name;
        const pay = row.payee && dek
          ? (decryptField(dek, String(row.payee)) ?? row.payee)
          : row.payee;
        return {
          transactionId: Number(row.id),
          date: row.date,
          accountId: Number(row.account_id),
          accountName: accName ?? null,
          quantity: qty,
          amount: Number(row.amount ?? 0),
          source: row.source ?? null,
          payee: pay ?? null,
          runningSum: Math.round(runningSum * 10000) / 10000,
        };
      });

      const totalQty = Math.round(runningSum * 10000) / 10000;
      // Group legs by account so the caller can compare each (holding,
      // account) pair against the brokerage statement directly.
      const perAccount = new Map<number, { accountId: number; accountName: string | null; qty: number; legCount: number }>();
      for (const l of legs) {
        const e = perAccount.get(l.accountId);
        if (e) { e.qty += l.quantity; e.legCount += 1; }
        else perAccount.set(l.accountId, { accountId: l.accountId, accountName: l.accountName, qty: l.quantity, legCount: 1 });
      }
      const perAccountArr = [...perAccount.values()].map((e) => ({
        ...e,
        qty: Math.round(e.qty * 10000) / 10000,
      }));

      return dataResponse({
        holdingId: resolvedHoldingId,
        totalLegs: legs.length,
        totalQty,
        unjoinedTransactionCount,
        unjoinedNote: unjoinedTransactionCount > 0
          ? `${unjoinedTransactionCount} transaction(s) reference this holding but their (holdingId, accountId) pair is NOT in holding_accounts — they are invisible to the four portfolio aggregators (issue #25). Investigate via search_transactions(portfolio_holding_id, account_id) and either bind the (holding, account) pair (POST /api/holding-accounts) or re-attribute the transaction.`
          : null,
        perAccount: perAccountArr,
        legs,
      });
    }
  );


  // ── get_investment_insights ────────────────────────────────────────────────
  server.tool(
    "get_investment_insights",
    "Portfolio-level investment analytics. `mode: 'patterns'` (default) returns contribution frequency, largest positions, diversification score. `mode: 'rebalancing'` suggests BUY/SELL amounts vs `targets`; each target's `holding` string is matched against a holding's NAME or SYMBOL (case-insensitive substring, same as get_portfolio_analysis), and positions sharing a symbol across accounts are aggregated into one current position. Targets matching no holding are listed in the response `warnings` array (rather than silently returning currentPct 0). `mode: 'benchmark'` compares book-value growth vs a reference index. All monetary aggregates are converted to reportingCurrency (defaults to user's display currency) so cross-currency portfolios aggregate sensibly.",
    {
      mode: z.enum(["patterns", "rebalancing", "benchmark"]).optional().describe("Analytics mode (default: patterns)"),
      targets: z.array(z.object({
        holding: z.string().describe("Holding name or symbol (case-insensitive substring match against the position's name + symbol; ticker symbols like VTI or VUN.TO work). Unmatched entries surface in the response `warnings` array."),
        target_pct: z.number().describe("Target allocation percentage (0-100)"),
      })).optional().describe("Required when mode='rebalancing'. Target allocations (should sum to ~100)."),
      benchmark: z.enum(["SP500", "TSX", "MSCI_WORLD", "BONDS_CA"]).optional().describe("Benchmark for mode='benchmark' (default SP500)"),
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency."),
    },
    async ({ mode, targets, benchmark, reportingCurrency }) => {
      const m = mode ?? "patterns";
      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const todayStr = new Date().toISOString().split("T")[0];
      const fxCache = new Map<string, number>();
      const fxFor = async (ccy: string): Promise<number> => {
        const k = (ccy || reporting).toUpperCase();
        if (fxCache.has(k)) return fxCache.get(k)!;
        const r = await getRate(k, reporting, todayStr, userId);
        fxCache.set(k, r);
        return r;
      };
      // Per-holding currency lookup so book values can be converted to a
      // common reporting unit before aggregation. Stream D Phase 4 — plaintext
      // name dropped; ciphertext only.
      const phRaw = await q(db, sql`
        SELECT name_ct, currency FROM portfolio_holdings WHERE user_id = ${userId}
      `);
      const holdingCurrencyByName = new Map<string, string>();
      for (const p of phRaw) {
        const name = p.name_ct && dek ? decryptField(dek, String(p.name_ct)) : null;
        if (name) holdingCurrencyByName.set(String(name), String(p.currency ?? reporting));
      }

      if (m === "rebalancing") {
        if (!targets?.length) return err("targets is required when mode='rebalancing'");
        // FINLYNQ-251: value ACTIVE positions, NOT lifetime book cost.
        // The prior code summed `aggregateHoldings().buy_amount` — the LIFETIME
        // total of every buy ever, which for a cash sleeve is all the money
        // that ever flowed THROUGH it (long since reinvested). That inflated
        // `totalPortfolioValue` to lifetime contributions (~$622K) and showed
        // cash sleeves at their lifetime flow-through, producing SELL
        // suggestions for cash that doesn't exist.
        //
        // Reuse the canonical valuation path (`getHoldingsValueByHolding`, the
        // "account with holdings = holdings.value" basis shared with
        // /api/portfolio/overview + net-worth): one row per active holding with
        // `value` = current MARKET value and `costBasis` = remaining (active)
        // cost basis, both in the ACCOUNT currency. A cash sleeve's `value` is
        // its CURRENT cash quantity (qty × 1); a sold-out position nets to qty
        // 0 → value 0. We prefer market value when prices are available and
        // fall back to active cost basis otherwise. FINLYNQ-151 DEK-gating: a
        // pf_ API key (no DEK) can't decrypt symbols to price them, so market
        // pricing needs the DEK — the fallback keeps it usable regardless.
        const holdingValues = await getHoldingsValueByHolding(userId, dek);
        // Detect whether ANY position carries a non-zero market value. When
        // nothing priced (no DEK / all unpriced), fall back to the active cost
        // basis so the rebalancer still produces meaningful percentages.
        const anyMarketValue = holdingValues.some((h) => Number(h.value) !== 0);
        const basis: "market" | "active-cost" = anyMarketValue ? "market" : "active-cost";
        // Issue #86: two holdings sharing a display name (TFSA + RRSP) come
        // through as separate rows. Sum across same-name rows when building the
        // rebalancing allocation map (rebalancing targets are user-supplied by
        // name; a target name maps to the union of all holdings with that name).
        // Convert each holding's value from its ACCOUNT currency to the
        // reporting currency before aggregating — otherwise mixing CAD + USD
        // produces nonsense percentages.
        const holdings: Array<{ name: string; symbol: string | null; book_value: number; book_value_native: number; currency: string }> = [];
        for (const h of holdingValues) {
          const nativeValue = basis === "market" ? Number(h.value) : Number(h.costBasis);
          const ccy = String(h.currency || reporting).toUpperCase();
          const fx = await fxFor(ccy);
          holdings.push({
            name: h.name ?? "(unnamed holding)",
            symbol: h.symbol ?? null,
            book_value: nativeValue * fx,
            book_value_native: nativeValue,
            currency: ccy,
          });
        }

        const totalBV = holdings.reduce((s, h) => s + Number(h.book_value), 0);
        if (totalBV === 0) return err("No portfolio holdings found");

        // FINLYNQ-252: aggregate by SYMBOL across accounts (fall back to name
        // for symbol-less rows like cash/custom). A ticker held in multiple
        // accounts (e.g. VUN.TO in TFSA + RRSP) sums into ONE current position
        // for rebalancing. Post-#86 those are separate holding rows. We keep
        // BOTH `name` and `symbol` on each bucket so a target string can be
        // matched against a `name + symbol` haystack, mirroring
        // get_portfolio_analysis's name+symbol match semantics (the schema doc
        // says `holding: Holding name or symbol`, but the prior code keyed the
        // map by name only, so ticker targets silently missed).
        const currentAlloc = new Map<string, { name: string; symbol: string | null; value: number; pct: number; currency: string; valueNative: number }>();
        for (const h of holdings) {
          const symLower = (h.symbol ?? "").trim().toLowerCase();
          const key = symLower || String(h.name).toLowerCase();
          const prev = currentAlloc.get(key);
          if (prev) {
            prev.value += Number(h.book_value);
            prev.valueNative += Number(h.book_value_native);
          } else {
            currentAlloc.set(key, {
              name: h.name,
              symbol: h.symbol ?? null,
              value: Number(h.book_value),
              pct: 0, // recomputed below from the summed value
              currency: h.currency,
              valueNative: Number(h.book_value_native),
            });
          }
        }
        for (const v of currentAlloc.values()) {
          v.pct = (v.value / totalBV) * 100;
        }

        // Issue #209 — track which currentAlloc keys were matched by a target
        // so we can surface the rest in `untargetedHoldings`. Without this,
        // a user passing two targets against a 60-holding portfolio gets
        // "BUY $X / BUY $Y" advice with no signal that the other 58 holdings
        // exist and remain at their current weight.
        const matchedAllocKeys = new Set<string>();
        // FINLYNQ-252: surface targets that match NO holding. A zero-match
        // target was previously indistinguishable from a genuinely-new
        // position (currentPct 0 => confident full-amount BUY). Mirrors the
        // `warnings` array get_portfolio_analysis returns for unmatched filters.
        const warnings: string[] = [];
        const suggestions = targets.map(t => {
          const lo = t.holding.trim().toLowerCase();
          // Match a target against a `name + symbol` haystack per bucket, the
          // same name-OR-symbol semantic as get_portfolio_analysis: a
          // case-insensitive substring of the combined name + symbol (so "VTI"
          // matches symbol "VTI", "VUN.TO" matches symbol "VUN.TO", and "Gold"
          // matches name "Gold"). The aggregation already keyed on symbol, so
          // a ticker held across accounts is a single bucket here.
          const matched = lo.length === 0 ? undefined : [...currentAlloc.entries()].find(([, v]) => {
            const haystack = `${String(v.name ?? "").toLowerCase()} ${String(v.symbol ?? "").toLowerCase()}`;
            return haystack.includes(lo);
          });
          if (matched) matchedAllocKeys.add(matched[0]);
          else warnings.push(`Target '${t.holding}' matched no holding; treated as a new position (currentPct 0).`);
          const current = matched?.[1];
          const currentPct = current?.pct ?? 0;
          const currentValue = current?.value ?? 0;
          const targetValue = (t.target_pct / 100) * totalBV;
          const diff = targetValue - currentValue;
          return {
            holding: t.holding,
            currentPct: Math.round(currentPct * 10) / 10,
            targetPct: t.target_pct,
            currentValue: Math.round(currentValue * 100) / 100,
            currentValueReporting: tagAmount(currentValue, reporting, "reporting"),
            targetValue: Math.round(targetValue * 100) / 100,
            targetValueReporting: tagAmount(targetValue, reporting, "reporting"),
            action: diff > 0 ? "BUY" : diff < 0 ? "SELL" : "HOLD",
            amount: Math.round(Math.abs(diff) * 100) / 100,
            amountReporting: tagAmount(Math.abs(diff), reporting, "reporting"),
          };
        });

        // Issue #209 — surface untargeted holdings explicitly so the caller
        // can decide whether the rebalancing recommendation is meaningful.
        // The user-facing total (`totalPortfolioValue`) is the WHOLE portfolio
        // book value across ALL holdings — never a subset — so the subset
        // truncation symptom in the audit cannot recur.
        let untargetedCount = 0;
        let untargetedTotal = 0;
        for (const [k, v] of currentAlloc.entries()) {
          if (!matchedAllocKeys.has(k)) {
            untargetedCount += 1;
            untargetedTotal += v.value;
          }
        }
        const targetedTotal = totalBV - untargetedTotal;

        return dataResponse({
          disclaimer: PORTFOLIO_DISCLAIMER,
          mode: "rebalancing",
          reportingCurrency: reporting,
          // FINLYNQ-251: 'market' when live prices were available, else
          // 'active-cost' (remaining cost basis of active positions). NEVER
          // lifetime book cost — cash sleeves are valued at current quantity.
          valuationBasis: basis,
          // Issue #209 — `totalPortfolioValue` is the whole-portfolio value
          // sum across ALL active holdings, never a top-N slice.
          totalPortfolioValue: Math.round(totalBV * 100) / 100,
          totalPortfolioValueReporting: tagAmount(totalBV, reporting, "reporting"),
          targetedPortfolioValueReporting: tagAmount(targetedTotal, reporting, "reporting"),
          untargetedHoldings: {
            count: untargetedCount,
            totalValueReporting: tagAmount(untargetedTotal, reporting, "reporting"),
            note: untargetedCount > 0
              ? "These holdings are not covered by `targets`; they remain at their current weight in the suggestions below."
              : "All holdings were matched by a target.",
          },
          suggestions,
          // FINLYNQ-252: any target that matched no holding is listed here
          // (empty array when all targets matched). A caller can then tell an
          // intentional new-position target apart from a mistyped ticker.
          warnings,
          note: basis === "market"
            ? "Values are current market value of active positions (cash sleeves valued at current cash balance). Percentages and BUY/SELL amounts reflect what you actually hold now."
            : "No live prices were available, so values are the remaining cost basis of active positions (cash sleeves at current cash balance), NOT lifetime contributions. Provide price data (or use an OAuth/built-in-chat session) for market-based rebalancing.",
        });
      }

      if (m === "benchmark") {
        const bm = benchmark ?? "SP500";
        const bmReturns: Record<string, { label: string; annualizedReturn: number; description: string }> = {
          SP500:      { label: "S&P 500",           annualizedReturn: 10.5, description: "US large-cap equities (USD)" },
          TSX:        { label: "S&P/TSX Composite",  annualizedReturn: 8.2,  description: "Canadian equities (CAD)" },
          MSCI_WORLD: { label: "MSCI World",          annualizedReturn: 9.4,  description: "Global developed markets (USD)" },
          BONDS_CA:   { label: "Canadian Bonds",      annualizedReturn: 3.8,  description: "Canadian aggregate bonds (CAD)" },
        };
        const bmInfo = bmReturns[bm];

        // Convert the per-currency totals to reporting before summing.
        // FK filter replaces the legacy `portfolio_holding IS NOT NULL` check
        // (column dropped in Phase 6).
        const investedRows = await q(db, sql`
          SELECT MIN(t.date) as first_date, MAX(t.date) as last_date,
                 COALESCE(t.currency, a.currency) AS currency,
                 SUM(ABS(t.amount)) as total_invested
          FROM transactions t
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.user_id = ${userId}
            AND t.portfolio_holding_id IS NOT NULL
            AND t.amount < 0
          GROUP BY COALESCE(t.currency, a.currency)
        `);
        if (!investedRows.length) {
          return dataResponse({ disclaimer: PORTFOLIO_DISCLAIMER, mode: "benchmark", message: "No investment transactions found" });
        }
        let totalInvested = 0;
        let firstDateStr: string | null = null;
        let lastDateStr: string | null = null;
        for (const r of investedRows) {
          const fx = await fxFor(String(r.currency ?? reporting));
          totalInvested += Number(r.total_invested) * fx;
          const fd = String(r.first_date);
          const ld = String(r.last_date);
          if (!firstDateStr || fd < firstDateStr) firstDateStr = fd;
          if (!lastDateStr || ld > lastDateStr) lastDateStr = ld;
        }
        const firstDate = new Date(String(firstDateStr));
        const lastDate = new Date(String(lastDateStr));
        const yearsHeld = Math.max(0.1, (lastDate.getTime() - firstDate.getTime()) / (365.25 * 86400000));

        const benchmarkFinalValue = totalInvested * Math.pow(1 + bmInfo.annualizedReturn / 100, yearsHeld);
        const benchmarkGain = benchmarkFinalValue - totalInvested;

        return dataResponse({
          disclaimer: PORTFOLIO_DISCLAIMER,
          mode: "benchmark",
          reportingCurrency: reporting,
          note: "Comparison uses book cost (not market value) and historical average returns. This is illustrative only.",
          yourPortfolio: {
            totalInvested: Math.round(totalInvested * 100) / 100,
            totalInvestedReporting: tagAmount(totalInvested, reporting, "reporting"),
            investingSince: firstDateStr,
            yearsInvesting: Math.round(yearsHeld * 10) / 10,
          },
          benchmark: {
            name: bmInfo.label,
            description: bmInfo.description,
            historicalAnnualizedReturn: `${bmInfo.annualizedReturn}%`,
            period: "10-year historical average (approximate)",
          },
          hypothetical: {
            message: `If your total invested ($${Math.round(totalInvested)} ${reporting} over ${Math.round(yearsHeld * 10) / 10} years) had earned ${bmInfo.annualizedReturn}% annually:`,
            finalValue: Math.round(benchmarkFinalValue * 100) / 100,
            finalValueReporting: tagAmount(benchmarkFinalValue, reporting, "reporting"),
            gain: Math.round(benchmarkGain * 100) / 100,
            gainReporting: tagAmount(benchmarkGain, reporting, "reporting"),
            gainPct: Math.round((benchmarkGain / totalInvested) * 1000) / 10,
          },
          limitations: [
            "Book cost ≠ market value — add current prices for real comparison",
            "Dollar-cost averaging timing not accounted for precisely",
            "Benchmark returns exclude fees, taxes, and currency conversion",
          ],
        });
      }

      // Default: mode === "patterns". FK filter replaces the legacy
      // `portfolio_holding IS NOT NULL` check (column dropped in Phase 6).
      const contributions = await q(db, sql`
        SELECT DATE_TRUNC('month', t.date::date) as month,
               COALESCE(t.currency, a.currency) AS currency,
               SUM(ABS(t.amount)) as invested
        FROM transactions t
        LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = ${userId}
          AND t.portfolio_holding_id IS NOT NULL
          AND t.amount < 0
        GROUP BY DATE_TRUNC('month', t.date::date), COALESCE(t.currency, a.currency)
        ORDER BY month DESC
      `);
      const monthlyByMonth = new Map<string, number>();
      for (const c of contributions) {
        const fx = await fxFor(String(c.currency ?? reporting));
        // Issue #209 — slice DATE_TRUNC's timestamp output to "YYYY-MM" so
        // the response month label is shape-stable across the project (matches
        // get_spending_trends + get_net_worth). Slicing BEFORE the map insert
        // is safe because the SQL groups by DATE_TRUNC('month', ...) so each
        // calendar month has exactly one row per currency.
        const key = String(c.month).slice(0, 7);
        monthlyByMonth.set(key, (monthlyByMonth.get(key) ?? 0) + Number(c.invested) * fx);
      }
      // Issue #209 — sort ascending (earliest → latest) so the response is
      // monotonic-by-time. Keep the trailing-12-months window for the average
      // (more statistically meaningful than the 6 we display); document the
      // population window in the response so callers can reconcile.
      const monthlyContributionsAll = [...monthlyByMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-12)
        .map(([month, invested]) => ({ month, invested: Math.round(invested * 100) / 100 }));

      // Issue #236: drop the `buysOnly: true` SQL pre-filter — see the
      // mode='rebalancing' branch above for the full rationale.
      const aggs = await aggregateHoldings(db, userId, dek);
      // Issue #86: aggregator now returns one row per holding_id. For the
      // top-positions display, sum book_value across same-name rows so
      // VUN.TO across TFSA + RRSP shows as a single "VUN.TO" line item with
      // the combined book_value (user-facing label is the holding name, not
      // the per-account split).
      const positionsByName = new Map<string, { name: string; book_value: number; book_value_native: number; currency: string; purchases: number }>();
      for (const a of aggs) {
        const ccy = holdingCurrencyByName.get(String(a.name)) ?? reporting;
        const fx = await fxFor(ccy);
        const key = String(a.name);
        const prev = positionsByName.get(key);
        if (prev) {
          prev.book_value += a.buy_amount * fx;
          prev.book_value_native += a.buy_amount;
          prev.purchases += a.purchases;
        } else {
          positionsByName.set(key, {
            name: a.name,
            book_value: a.buy_amount * fx,
            book_value_native: a.buy_amount,
            currency: ccy,
            purchases: a.purchases,
          });
        }
      }
      const positions = Array.from(positionsByName.values());
      positions.sort((a, b) => b.book_value - a.book_value);

      // Issue #209: `totalInvested` reduces over the FULL `positions` array
      // (sum across all holdings, not the top-5 displayed). This stays LIFETIME
      // contributions (every dollar ever invested) and is the labelled
      // `summary.totalInvested` figure below.
      const totalInvested = positions.reduce((s, p) => s + Number(p.book_value), 0);

      // FINLYNQ-253: diversification / concentration / topPositions must NOT be
      // weighted on lifetime book cost. The prior code reused `positions`
      // (lifetime `aggregateHoldings().buy_amount`), so the cash sleeves —
      // whose lifetime value is every dollar that ever transited the brokerage,
      // not a held position — dominated the top-3, mislabelling a 15+ holding
      // ~55%-ETF portfolio as "Concentrated (in cash)". Mirror the FINLYNQ-251
      // rebalancing fix: value ACTIVE positions via the canonical
      // `getHoldingsValueByHolding` (the "account with holdings = holdings.value"
      // basis shared with /api/portfolio/overview + net-worth) — prefer current
      // MARKET value, fall back to remaining ACTIVE cost basis (excl. sold-out)
      // when no live prices are available (e.g. a pf_ API key with no DEK) —
      // AND exclude cash-sleeve rows entirely from the concentration set (no
      // investor should read "concentrated in cash" off flow-through). Cash is
      // held wealth but not an investment position, so it's dropped from the
      // diversification-of-investments weighting.
      const cashSleeveIdRows = await q(db, sql`
        SELECT id FROM portfolio_holdings
        WHERE user_id = ${userId} AND is_cash = TRUE
      `);
      const cashSleeveIds = new Set(cashSleeveIdRows.map((r) => Number(r.id)));
      const holdingValues = await getHoldingsValueByHolding(userId, dek);
      // Prefer market value; fall back to active cost basis when nothing priced
      // (no DEK / all unpriced) so the score stays meaningful either way.
      const anyMarketValue = holdingValues.some((h) => !cashSleeveIds.has(Number(h.holdingId)) && Number(h.value) !== 0);
      const activeBasis: "market" | "active-cost" = anyMarketValue ? "market" : "active-cost";
      // Sum active value across same-name rows (VUN.TO across TFSA + RRSP is one
      // line), FX-converting each holding's ACCOUNT currency to the reporting
      // currency first. Cash sleeves are excluded from this set.
      const activeByName = new Map<string, { name: string; value: number; value_native: number; currency: string }>();
      for (const h of holdingValues) {
        if (cashSleeveIds.has(Number(h.holdingId))) continue;
        const nativeValue = activeBasis === "market" ? Number(h.value) : Number(h.costBasis);
        if (!(nativeValue > 0)) continue; // sold-out / zero-value positions don't weigh
        const ccy = String(h.currency || reporting).toUpperCase();
        const fx = await fxFor(ccy);
        const key = h.name ?? "(unnamed holding)";
        const prev = activeByName.get(key);
        if (prev) {
          prev.value += nativeValue * fx;
          prev.value_native += nativeValue;
        } else {
          activeByName.set(key, { name: key, value: nativeValue * fx, value_native: nativeValue, currency: ccy });
        }
      }
      const activePositions = Array.from(activeByName.values());
      activePositions.sort((a, b) => b.value - a.value);
      // Merge the lifetime `purchases` count (per name) from `aggregateHoldings`
      // for the topPositions display — value comes from the active set, the
      // purchase count is a lifetime fact.
      const purchasesByName = new Map<string, number>();
      for (const p of positions) purchasesByName.set(p.name, Number(p.purchases));

      // Weight diversification / concentration on the ACTIVE, cash-excluded set.
      const activeTotal = activePositions.reduce((s, p) => s + Number(p.value), 0);
      const top3Pct = activePositions.slice(0, 3).reduce((s, p) => s + Number(p.value), 0) / (activeTotal || 1);
      const diversificationScore = Math.max(0, Math.round((1 - top3Pct) * 100));

      // Issue #209 — average reconciles against the trailing-12 population,
      // documented explicitly in the response. `monthlyContributions[]` is
      // sliced to 6 for display further down.
      const avgMonthlyContrib = monthlyContributionsAll.length > 0
        ? monthlyContributionsAll.reduce((s, c) => s + Number(c.invested), 0) / monthlyContributionsAll.length
        : 0;
      // Issue #209 — display window is the most-recent 6 (the trailing edge
      // of the trailing-12 window).
      const monthlyContributionsDisplayed = monthlyContributionsAll.slice(-6);

      return dataResponse({
        disclaimer: PORTFOLIO_DISCLAIMER,
        mode: "patterns",
        reportingCurrency: reporting,
        summary: {
          totalPositions: positions.length,
          totalInvested: Math.round(totalInvested * 100) / 100,
          totalInvestedReporting: tagAmount(totalInvested, reporting, "reporting"),
          avgMonthlyContribution: Math.round(avgMonthlyContrib * 100) / 100,
          avgMonthlyContributionReporting: tagAmount(avgMonthlyContrib, reporting, "reporting"),
          // Issue #209 — explicit population window so callers can reconcile
          // `avgMonthlyContribution` against the listed `monthlyContributions[]`
          // (which is sliced to 6 for display).
          avgMonthlyContributionPopulation: "trailing-12-months",
          monthlyContributionsDisplayedCount: monthlyContributionsDisplayed.length,
          diversificationScore,
          // Issue #209 — explicit scale documentation. The score is 0–100,
          // higher = more diversified; previously implicit.
          diversificationScoreMax: 100,
          diversificationLabel: diversificationScore > 70 ? "Well diversified" : diversificationScore > 40 ? "Moderately diversified" : "Concentrated",
          // FINLYNQ-253: concentration + diversificationScore are weighted on
          // ACTIVE, cash-excluded positions (see topPositions). `totalInvested`
          // above stays LIFETIME contributions.
          concentration: `Top 3 active positions = ${Math.round(top3Pct * 1000) / 10}% of active holdings`,
          // 'market' when live prices were available for the active set, else
          // 'active-cost' (remaining cost basis of active positions). NEVER
          // lifetime book cost, and cash sleeves are excluded.
          diversificationValuationBasis: activeBasis,
        },
        // FINLYNQ-253: topPositions are the top-5 ACTIVE positions (cash
        // sleeves excluded), valued at market (or active cost basis when no
        // live prices), NOT lifetime book cost. `pct` is the share of the
        // active, cash-excluded portfolio — so the concentration figure and
        // these rows agree.
        topPositions: activePositions.slice(0, 5).map(p => ({
          name: p.name,
          value: Math.round(Number(p.value) * 100) / 100,
          valueReporting: tagAmount(p.value, reporting, "reporting"),
          valueNative: tagAmount(p.value_native, p.currency, "account"),
          pct: Math.round((Number(p.value) / (activeTotal || 1)) * 1000) / 10,
          purchases: Number(purchasesByName.get(p.name) ?? 0),
        })),
        // Issue #209 — already sorted ASC by month and sliced to the trailing
        // 6 (most recent) above. Months are formatted as "YYYY-MM".
        monthlyContributions: monthlyContributionsDisplayed.map(c => ({
          month: c.month,
          invested: c.invested,
          investedReporting: tagAmount(c.invested, reporting, "reporting"),
        })),
      });
    }
  );
}
