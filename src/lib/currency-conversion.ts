/**
 * Currency conversion helper for write paths.
 *
 * Single chokepoint that turns "user typed amount X in currency Y on date D"
 * into the (entered, account) trilogy fields the DB stores.
 *
 * Returns the rate's source so callers can decide what to do on a fallback:
 *   - 'override' / 'yahoo' / 'coingecko' / 'stale' — write the row
 *   - 'fallback' — refuse to write; surface a 409 fx-currency-needs-override
 *     so the user is prompted to add a custom rate via Settings → Custom
 *     exchange rates.
 *
 * NEVER persist a transaction with source='fallback' — that's silently
 * wrong amounts. The caller MUST inspect the source.
 */

import { getRateToUsdDetailed, type RateSource } from "@/lib/fx-service";

export type ConversionResult = {
  /** Account-currency amount = entered_amount * entered_fx_rate. Rounded to 2 decimals. */
  amount: number;
  /** Account currency (echoes the input — convenience for callers writing rows). */
  currency: string;
  /** Locked-at-entry rate: 1 unit of enteredCurrency = enteredFxRate units of accountCurrency. */
  enteredFxRate: number;
  /** Where the rate came from. Callers MUST refuse to write on 'fallback'. */
  source: RateSource;
};

export type ConversionInput = {
  enteredAmount: number;
  enteredCurrency: string;
  accountCurrency: string;
  /** Transaction's date (YYYY-MM-DD). Determines which day's rate is locked. */
  date: string;
  userId: string;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Convert an entered amount in one currency into the account's currency.
 * Triangulates through USD: rate(from→to) = rate_to_usd[from] / rate_to_usd[to].
 *
 * Same-currency case short-circuits with rate=1 (source='yahoo' as a sentinel
 * meaning "no fetch needed" — never returned for non-trivial conversions).
 */
export async function convertToAccountCurrency(input: ConversionInput): Promise<ConversionResult> {
  const enteredCurrency = input.enteredCurrency.trim().toUpperCase();
  const accountCurrency = input.accountCurrency.trim().toUpperCase();
  const enteredAmount = input.enteredAmount;

  if (enteredCurrency === accountCurrency) {
    return {
      amount: round2(enteredAmount),
      currency: accountCurrency,
      enteredFxRate: 1,
      source: "yahoo",
    };
  }

  const [fromUsd, toUsd] = await Promise.all([
    getRateToUsdDetailed(enteredCurrency, input.date, input.userId),
    getRateToUsdDetailed(accountCurrency, input.date, input.userId),
  ]);

  // Worst source dominates — if either leg is 'fallback', the whole conversion is.
  const source: RateSource =
    fromUsd.source === "fallback" || toUsd.source === "fallback"
      ? "fallback"
      : fromUsd.source === "stale" || toUsd.source === "stale"
        ? "stale"
        : fromUsd.source === "override" || toUsd.source === "override"
          ? "override"
          : fromUsd.source;

  if (toUsd.rate === 0) {
    return {
      amount: round2(enteredAmount),
      currency: accountCurrency,
      enteredFxRate: 1,
      source: "fallback",
    };
  }

  const rate = fromUsd.rate / toUsd.rate;
  const amount = round2(enteredAmount * rate);

  return {
    amount,
    currency: accountCurrency,
    enteredFxRate: rate,
    source,
  };
}

/**
 * Same as convertToAccountCurrency but never throws and always returns a
 * usable ConversionResult — used by import preview where partial failures
 * surface as transformErrors rather than aborting the whole batch.
 */
export async function safeConvertToAccountCurrency(
  input: ConversionInput
): Promise<ConversionResult> {
  try {
    return await convertToAccountCurrency(input);
  } catch {
    return {
      amount: round2(input.enteredAmount),
      currency: input.accountCurrency.toUpperCase(),
      enteredFxRate: 1,
      source: "fallback",
    };
  }
}

/**
 * Web-framework-free resolver for the entered/account trilogy. Used by
 * /api/transactions, /api/transactions/bulk, and MCP write tools so all
 * write paths produce identical (amount, currency, entered_*) shapes.
 *
 * Branches:
 *  - enteredAmount provided → triangulate to account currency. Refuses on
 *    fallback rate so we don't silently write a wrong amount.
 *  - amount provided (legacy) → mirror as entered with rate=1. Currency
 *    defaults to account currency.
 *  - Neither → caller bug.
 */
export type ResolveTxResult =
  | {
      ok: true;
      amount: number;
      currency: string;
      enteredAmount: number;
      enteredCurrency: string;
      enteredFxRate: number;
    }
  | {
      ok: false;
      code: "missing-amount" | "fx-currency-needs-override";
      message: string;
      currency?: string;
    };

export async function resolveTxAmountsCore(opts: {
  accountCurrency: string;
  date: string;
  userId: string;
  amount?: number;
  currency?: string;
  enteredAmount?: number;
  enteredCurrency?: string;
}): Promise<ResolveTxResult> {
  const accountCurrency = opts.accountCurrency.trim().toUpperCase();

  if (opts.enteredAmount != null) {
    const enteredCurrency = (opts.enteredCurrency ?? accountCurrency).trim().toUpperCase();
    const conv = await convertToAccountCurrency({
      enteredAmount: opts.enteredAmount,
      enteredCurrency,
      accountCurrency,
      date: opts.date,
      userId: opts.userId,
    });
    if (conv.source === "fallback") {
      return {
        ok: false,
        code: "fx-currency-needs-override",
        currency: enteredCurrency,
        message: `No FX rate available for ${enteredCurrency}. Add a custom rate via Settings → Custom exchange rates first.`,
      };
    }
    return {
      ok: true,
      amount: conv.amount,
      currency: accountCurrency,
      enteredAmount: opts.enteredAmount,
      enteredCurrency,
      enteredFxRate: conv.enteredFxRate,
    };
  }

  if (opts.amount != null) {
    const currency = (opts.currency ?? accountCurrency).trim().toUpperCase();
    return {
      ok: true,
      amount: opts.amount,
      currency,
      enteredAmount: opts.amount,
      enteredCurrency: currency,
      enteredFxRate: 1,
    };
  }

  return { ok: false, code: "missing-amount", message: "amount or enteredAmount is required" };
}
