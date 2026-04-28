/**
 * Currency-aware MCP response shape.
 *
 * Every MCP read tool that returns an amount wraps it in a TaggedAmount so
 * the caller (Claude, an integration) knows which layer of the entered/
 * account/reporting trilogy they're looking at.
 *
 * - 'entered': what the user typed (trade currency)
 * - 'account': the settlement amount in the account's currency
 * - 'reporting': converted to the user's display currency (or a caller-
 *                supplied reportingCurrency)
 *
 * Tools accept an optional `currencyMode` parameter to pick which side to
 * surface. Sensible defaults:
 *   - per-row reads default to 'entered' — Claude sees actual data
 *   - aggregations default to 'reporting' — you can't sum mixed currencies
 *   - single-account reads default to 'account'
 */

export type CurrencyType = "entered" | "account" | "reporting";

export type TaggedAmount = {
  amount: number;
  currency: string;
  type: CurrencyType;
};

export function tagAmount(amount: number, currency: string, type: CurrencyType): TaggedAmount {
  return {
    amount: Math.round(amount * 100) / 100,
    currency: currency.toUpperCase(),
    type,
  };
}

/**
 * Tag a transaction's amounts with all three layers when both are available.
 * Reporting is computed only when reportingRate is supplied.
 */
export type TxAmountInputs = {
  enteredAmount: number;
  enteredCurrency: string;
  accountAmount: number;
  accountCurrency: string;
  reportingCurrency?: string;
  reportingRate?: number;
};

export type TxAmountOutputs = {
  enteredAmount: TaggedAmount;
  accountAmount: TaggedAmount;
  reportingAmount?: TaggedAmount;
};

export function tagTxAmounts(opts: TxAmountInputs): TxAmountOutputs {
  const out: TxAmountOutputs = {
    enteredAmount: tagAmount(opts.enteredAmount, opts.enteredCurrency, "entered"),
    accountAmount: tagAmount(opts.accountAmount, opts.accountCurrency, "account"),
  };
  if (opts.reportingCurrency && opts.reportingRate != null) {
    out.reportingAmount = tagAmount(
      opts.accountAmount * opts.reportingRate,
      opts.reportingCurrency,
      "reporting"
    );
  }
  return out;
}
