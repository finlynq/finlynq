import { NextRequest, NextResponse } from "next/server";
import { getLatestFxRate, getActiveCurrencies, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { getAccountBalances } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const target = request.nextUrl.searchParams.get("target") ?? "CAD";

  const balances = await getAccountBalances(userId);
  const activeCurrencies = await getActiveCurrencies();

  // Build rate map: every active currency → target
  const rateMap = await getRateMap(target);

  // Build rates object for response
  const rates: Record<string, number> = {};
  for (const currency of activeCurrencies) {
    if (currency !== target) {
      const rate = rateMap.get(currency) ?? 1;
      rates[`${currency}${target}`] = rate;
    }
  }

  // Consolidated total
  let total = 0;
  const byAccount = balances.map((b) => {
    const converted = convertWithRateMap(b.balance, b.currency, rateMap);
    total += converted;
    return {
      ...b,
      convertedBalance: converted,
      targetCurrency: target,
    };
  });

  return NextResponse.json({
    rates,
    activeCurrencies,
    displayCurrency: target,
    consolidated: {
      currency: target,
      total: Math.round(total * 100) / 100,
    },
    byAccount,
  });
}
