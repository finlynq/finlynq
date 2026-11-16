import type { GuideModule } from "../types";

export const guide: GuideModule = {
  id: "portfolio",
  title: "Investments and the portfolio",
  summary: "Record trades, income and transfers in investment accounts, and read holdings, returns and lots.",
  order: 20,
  markdown: `# Investments and the portfolio

Everything here is bookkeeping in the user's own records. Nothing places an order or moves real money. Portfolio figures are for information only and are not financial advice; say so when you share them.

## Reading
- \`get_portfolio_analysis\`: holdings, values, cost and gains, grouped by account and by security.
- \`get_portfolio_performance\` and \`get_portfolio_returns\`: returns over time. New money (deposits, transfers in, opening balances) is taken out, so returns measure investment results only.
- \`analyze_holding\`: one holding in detail. \`trace_holding_quantity\` explains how its quantity was reached, row by row.
- \`get_investment_insights\` with \`mode\`: \`patterns\` (default), \`rebalancing\` (needs targets) or \`benchmark\` (needs a benchmark).
- \`get_dividend_income\` and \`get_realized_gains\`.
Every money figure carries a \`basis\` (market value, cost, ledger) so you know what it measures. Weights should come from the same basis.

## Recording
Investment accounts only take entries through \`portfolio_record_entry\`; \`manage_transactions\` and \`manage_transfers\` refuse them. Pick the \`entry_type\`:
- \`buy\` / \`sell\`: a trade paid from or into the account's cash in that currency.
- \`income_expense\`: a dividend, interest or fee. With \`settleAs: "shares"\` it is income taken as shares (a reinvested dividend, a share grant) in one entry.
- \`deposit\` / \`withdrawal\`: cash moving between this account and a bank account.
- \`transfer\`: shares moving between two accounts.
- \`swap\`: one security exchanged for another.
- \`fx_conversion\`: cash converted between currencies inside the account.

A trade needs cash in the trade's currency. If the account has none yet, create it with \`manage_holdings(op='add_cash_sleeve')\`. New securities are added with \`manage_holdings(op='add')\`. Entries are created this way; editing an existing trade is done in the web app.

## Cost basis
The user picks one of two methods (\`manage_lots(op='status')\` tells you which):
- **Simple** (default): the average price of every purchase, sold shares included.
- **Advanced lot allocation**: each sale is matched to specific purchases (first in, first out unless changed). \`manage_lots(op='list')\` shows the lots, \`op='reassign'\` changes which lots one sale used (preview first), \`op='rebuild'\` replays a holding's trades.
Tell the user which method a figure uses when cost or gains matter.

## Things that trip people up
- A sale bigger than the shares held opens a short position; a later buy closes it.
- Tiny leftovers from rounding (a few ten-thousandths of a unit worth under 5 cents) count as closed.
- Prices come from Yahoo Finance and CoinGecko. A ticker that never priced may be wrong or delisted; the Securities tab in Settings → Investments flags it and offers a fix or a manual price.
`,
};
