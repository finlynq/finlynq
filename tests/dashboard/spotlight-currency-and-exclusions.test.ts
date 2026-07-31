/**
 * Static gates for the dashboard Action Center (src/lib/spotlight.ts).
 *
 * WHY STATIC
 * ----------
 * Every spotlight builder is a `db` query wrapped in a little arithmetic, so a
 * behavioural test would be mostly Drizzle mock. The two defects that actually
 * shipped are both visible in the source, and both are the kind that creep back
 * in when someone adds an eighth builder by copying a seventh:
 *
 *  1. A hardcoded currency. `action-center.tsx` rendered every amount as CAD,
 *     so a USD account showed `C$304.47` next to `$704.47` from the same row.
 *     Underneath, five of the six money builders emitted NATIVE, unconverted
 *     amounts and six descriptions hardcoded a `$` — so fixing only the label
 *     would have relabelled a wrong number.
 *  2. An alert nobody can clear. The uncategorized count included portfolio
 *     trades, which are REQUIRED to keep `categoryId: null`, and transfer legs,
 *     whose categorisation belongs to the pair. On pf_dev the current-month
 *     count was 100% such rows.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SPOTLIGHT = readFileSync(path.join(ROOT, "src/lib/spotlight.ts"), "utf8");
const CARD = readFileSync(
  path.join(ROOT, "src/app/(app)/dashboard/_components/action-center.tsx"),
  "utf8",
);

/** Strip comments — these files document the very patterns we forbid. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("spotlight — uncategorized count", () => {
  it("excludes portfolio rows and every transfer-link variant", () => {
    const start = SPOTLIGHT.indexOf("async function getUncategorizedTransactions");
    expect(start, "getUncategorizedTransactions not found — renamed?").toBeGreaterThan(-1);
    const body = SPOTLIGHT.slice(start, SPOTLIGHT.indexOf("\n}", start));

    // Portfolio trades keep categoryId NULL by invariant — counting them asks
    // the user to do something the system forbids.
    expect(body).toContain("portfolioHoldingId} IS NULL");
    // All three link ids: link_id (transfers, brokerage legs), trade_link_id,
    // swap_link_id. Missing one lets that pair type back into the count.
    expect(body).toContain("linkId} IS NULL");
    expect(body).toContain("tradeLinkId} IS NULL");
    expect(body).toContain("swapLinkId} IS NULL");
  });

  it("drills through to the month it counted, via the single-source helper", () => {
    const start = SPOTLIGHT.indexOf("async function getUncategorizedTransactions");
    const body = SPOTLIGHT.slice(start, SPOTLIGHT.indexOf("\n}", start));
    expect(body).toContain("buildTxDrillUrl(");
    expect(
      body,
      "a bare '/transactions' drops the user into an unfiltered list with no way " +
        "to find the rows the alert is about",
    ).not.toContain('actionUrl: "/transactions"');
  });
});

describe("spotlight — currency", () => {
  it("emits a currency on every item and never hardcodes one in the card", () => {
    expect(SPOTLIGHT).toContain("currency: string");
    expect(
      codeOnly(CARD),
      "action-center.tsx must read item.currency, not assume a currency",
    ).not.toMatch(/formatCurrency\([^)]*,\s*["'](CAD|USD)["']\s*\)/);
    expect(codeOnly(CARD)).toContain("formatCurrency(item.amount, item.currency)");
  });

  it("formats money through formatCurrency, never a bare $ template literal", () => {
    // `$${x.toFixed(2)}` in a description is a hardcoded dollar sign that
    // survives any currency change. There were six.
    const code = codeOnly(SPOTLIGHT);
    const bareDollar = code.match(/\$\$\{/g) ?? [];
    expect(
      bareDollar.length,
      `found ${bareDollar.length} hardcoded "$" interpolation(s) — use formatCurrency`,
    ).toBe(0);
  });

  it("hands the rate context to every builder, so none can emit native amounts", () => {
    // The bug was that only getLowBalances took `fx`. Any builder that reads
    // money and does not take the rate context is emitting unconverted figures.
    const builders = [
      "getOverspentBudgets",
      "getUpcomingLargeBills",
      "getGoalDeadlines",
      "getSpendingAnomalies",
      "getLowBalances",
      "getUpcomingSubscriptions",
    ];
    for (const name of builders) {
      const start = SPOTLIGHT.indexOf(`async function ${name}(`);
      expect(start, `${name} not found — renamed?`).toBeGreaterThan(-1);
      const signature = SPOTLIGHT.slice(start, SPOTLIGHT.indexOf(")", start) + 1);
      expect(signature, `${name} must take the rate context`).toContain("fx: RateCtx");
    }
  });

  it("converts mixed-currency spend per slice instead of summing natively", () => {
    // FINLYNQ-123: SUM(amount) across currencies under one label is meaningless.
    // Budgets and anomalies must group by transactions.currency and convert.
    for (const name of ["getOverspentBudgets", "getSpendingAnomalies"]) {
      const start = SPOTLIGHT.indexOf(`async function ${name}(`);
      const body = SPOTLIGHT.slice(start, SPOTLIGHT.indexOf("\n}\n", start));
      expect(body, `${name} must group by currency`).toContain("transactions.currency");
      expect(body, `${name} must convert each slice`).toContain("convertWithRateMap(");
    }
  });

  it("applies the large-bill / renewal thresholds to the CONVERTED amount", () => {
    // The two builders split subscriptions at 100. Testing the native amount
    // puts a ¥5,000 sub (~$33) in the "large bill" bucket and a £90 one (~$115)
    // in "renewals" — and the buckets are complements, so both must agree.
    for (const name of ["getUpcomingLargeBills", "getUpcomingSubscriptions"]) {
      const start = SPOTLIGHT.indexOf(`async function ${name}(`);
      const body = SPOTLIGHT.slice(start, SPOTLIGHT.indexOf("\n}\n", start));
      expect(
        body,
        `${name} must not threshold on the raw sub.amount`,
      ).not.toMatch(/Math\.abs\(s(ub)?\.amount\)\s*[<>]=?\s*100/);
      expect(body).toContain("convertWithRateMap(");
    }
  });
});
