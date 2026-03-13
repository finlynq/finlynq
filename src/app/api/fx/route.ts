import { NextRequest, NextResponse } from "next/server";
import { getLatestFxRate } from "@/lib/fx-service";
import { getAccountBalances } from "@/lib/queries";

export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get("target") ?? "CAD";

  const rate = await getLatestFxRate("USD", "CAD");
  const reverseRate = await getLatestFxRate("CAD", "USD");

  // Consolidated balances
  const balances = getAccountBalances();
  let totalCAD = 0;
  let totalUSD = 0;

  for (const b of balances) {
    if (target === "CAD") {
      totalCAD += b.currency === "CAD" ? b.balance : b.balance * rate;
    } else {
      totalUSD += b.currency === "USD" ? b.balance : b.balance * reverseRate;
    }
  }

  return NextResponse.json({
    rates: { USDCAD: rate, CADUSD: reverseRate },
    consolidated: {
      currency: target,
      total: Math.round((target === "CAD" ? totalCAD : totalUSD) * 100) / 100,
    },
    byAccount: balances.map((b) => ({
      ...b,
      convertedBalance: Math.round(
        (target === "CAD"
          ? b.currency === "CAD" ? b.balance : b.balance * rate
          : b.currency === "USD" ? b.balance : b.balance * reverseRate
        ) * 100
      ) / 100,
      targetCurrency: target,
    })),
  });
}
