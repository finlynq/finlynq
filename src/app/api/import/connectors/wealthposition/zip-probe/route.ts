import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { runZipProbe } from "@/lib/external-import/zip-orchestrator";

const MAX_ZIP_BYTES = 10 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const cl = Number(request.headers.get("content-length") ?? 0);
  if (cl && cl > MAX_ZIP_BYTES) {
    return NextResponse.json({ error: "ZIP exceeds 10 MB" }, { status: 413 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' form field" }, { status: 400 });
  }
  if (file.size > MAX_ZIP_BYTES) {
    return NextResponse.json({ error: "ZIP exceeds 10 MB" }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const result = await runZipProbe(auth.userId, buffer, auth.dek);
    return NextResponse.json({
      external: {
        accounts: result.parsed.accounts,
        categories: result.parsed.categories,
        portfolio: [...result.parsed.portfolioByHolding.entries()].map(([holding, info]) => ({
          holding,
          brokerageAccount: info.brokerageAccount,
          symbol: info.symbol,
          currency: info.currency,
        })),
        sampleTransactions: result.sampleTransactions,
        transactionsTotal: result.parsed.transactions.length,
      },
      finlynq: {
        accounts: result.finlynqAccounts,
        categories: result.finlynqCategories,
      },
      mapping: result.mapping,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse ZIP";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
