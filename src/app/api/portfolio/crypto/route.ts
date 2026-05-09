import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { getCryptoPrices, symbolToCoinGeckoId } from "@/lib/crypto-service";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { buildNameFields, decryptNamedRows } from "@/lib/crypto/encrypted-columns";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    // Stream D Phase 4 — plaintext name/symbol/accountName columns dropped.
    const allRaw = await db
      .select({
        id: schema.portfolioHoldings.id,
        accountId: schema.portfolioHoldings.accountId,
        accountNameCt: schema.accounts.nameCt,
        nameCt: schema.portfolioHoldings.nameCt,
        symbolCt: schema.portfolioHoldings.symbolCt,
        currency: schema.portfolioHoldings.currency,
        isCrypto: schema.portfolioHoldings.isCrypto,
        note: schema.portfolioHoldings.note,
      })
      .from(schema.portfolioHoldings)
      .leftJoin(schema.accounts, eq(schema.portfolioHoldings.accountId, schema.accounts.id))
      .where(eq(schema.portfolioHoldings.userId, userId))
      .all();
    const allHoldings = decryptNamedRows(allRaw, auth.context.dek, {
      nameCt: "name",
      symbolCt: "symbol",
      accountNameCt: "accountName",
    }) as Array<typeof allRaw[number] & { name: string | null; symbol: string | null; accountName: string | null }>;

    // Filter to crypto holdings
    const CRYPTO_SYMBOLS = new Set([
      "BTC", "ETH", "SOL", "ADA", "XRP", "DOGE", "AAVE", "ATOM", "AVAX",
      "CRV", "FTM", "HBAR", "LINK", "LTC", "MATIC", "POL", "DOT", "XLM",
      "UNI", "YFI", "SNX", "BNB", "SHIB", "ARB", "OP", "APT", "SUI",
      "NEAR", "FIL", "ICP", "ALGO", "XTZ", "EOS", "SAND", "MANA", "AXS", "S",
    ]);

    const cryptoHoldings = allHoldings.filter((h) => {
      if (h.isCrypto === 1) return true;
      if (!h.symbol) return false;
      const base = String(h.symbol).toUpperCase().split("-")[0];
      return CRYPTO_SYMBOLS.has(base);
    });

    // Fetch prices from CoinGecko
    const coinGeckoIds: string[] = [];
    const symbolToId = new Map<string, string>();
    for (const h of cryptoHoldings) {
      if (!h.symbol) continue;
      const base = String(h.symbol).toUpperCase().split("-")[0];
      const cgId = symbolToCoinGeckoId(base);
      if (cgId && !symbolToId.has(base)) {
        symbolToId.set(base, cgId);
        coinGeckoIds.push(cgId);
      }
    }

    const prices = await getCryptoPrices(coinGeckoIds);
    const priceMap = new Map(prices.map((p) => [p.symbol.toUpperCase(), p]));

    // Enrich holdings with price data
    const enriched = cryptoHoldings.map((h) => {
      const base = h.symbol ? String(h.symbol).toUpperCase().split("-")[0] : "";
      const priceData = priceMap.get(base);
      return {
        ...h,
        price: priceData?.price ?? null,
        change24h: priceData?.change24h ?? null,
        changePct24h: priceData?.changePct24h ?? null,
        marketCap: priceData?.marketCap ?? null,
        image: priceData?.image ?? null,
      };
    });

    return NextResponse.json(enriched);
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Failed to fetch crypto holdings");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const userId = auth.userId;
  try {
    const body = await request.json();

    const cryptoSchema = z.object({
      name: z.string(),
      symbol: z.string(),
      accountId: z.number().optional(),
      currency: z.string().optional(),
      note: z.string().optional(),
    });
    const parsed = validateBody(body, cryptoSchema);
    if (parsed.error) return parsed.error;

    const { name, symbol, accountId, currency, note } = parsed.data;

    // Stream D Phase 4 — plaintext name/symbol dropped; encrypt + dual-write
    // ct/lookup pair via buildNameFields.
    const enc = buildNameFields(auth.dek, { name, symbol: symbol.toUpperCase() });
    const holding = await db
      .insert(schema.portfolioHoldings)
      .values({
        accountId: accountId ?? null,
        currency: currency ?? "CAD",
        isCrypto: 1,
        note: note ?? "",
        userId,
        ...enc,
      })
      .returning()
      .get();

    // Issue #205 — dual-write holding_accounts pairing when accountId is
    // present. Crypto holdings without an account stay unpaired (no aggregator
    // JOIN to satisfy). On failure, DELETE the orphan portfolio_holdings row.
    if (accountId != null) {
      try {
        await db
          .insert(schema.holdingAccounts)
          .values({
            holdingId: holding.id,
            accountId,
            userId,
            qty: 0,
            costBasis: 0,
            isPrimary: true,
          })
          .onConflictDoNothing();
      } catch (pairingErr) {
        await db
          .delete(schema.portfolioHoldings)
          .where(
            and(
              eq(schema.portfolioHoldings.id, holding.id),
              eq(schema.portfolioHoldings.userId, userId),
            ),
          );
        throw pairingErr;
      }
    }

    return NextResponse.json(holding);
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Failed to create crypto holding");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
