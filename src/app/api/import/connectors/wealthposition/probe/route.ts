import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { wealthposition } from "@finlynq/import-connectors/wealthposition";
import { WealthPositionApiError } from "@finlynq/import-connectors/wealthposition";
import type { ExternalTransaction } from "@finlynq/import-connectors";
import { loadConnectorCredentials } from "@/lib/external-import/credentials";
import { getAccounts, getCategories } from "@/lib/queries";
import { loadConnectorMapping } from "@/lib/external-import/mapping";

const CONNECTOR_ID = "wealthposition";

export async function GET(request: NextRequest) {
  // Needs DEK to unwrap the stored API key.
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const creds = await loadConnectorCredentials<{ apiKey: string }>(
    userId,
    CONNECTOR_ID,
    dek,
  );
  if (!creds?.apiKey) {
    return NextResponse.json(
      { error: "No WealthPosition credentials on file. Save an API key first." },
      { status: 400 },
    );
  }

  const client = wealthposition.createClient({ apiKey: creds.apiKey });

  let wpAccounts, wpCategories;
  let samplePage: ExternalTransaction[] = [];
  try {
    [wpAccounts, wpCategories] = await Promise.all([
      client.listAccounts(),
      client.listCategories(),
    ]);
    // One page of transactions for the mapping dialog sample section.
    for await (const page of client.listTransactions({})) {
      samplePage = page.slice(0, 5);
      break;
    }
  } catch (err) {
    if (err instanceof WealthPositionApiError) {
      const status = err.httpStatus === 401 || err.code === "AUTHENTICATION_ERROR" ? 401 : 502;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    throw err;
  }

  // Finlynq side — what the user can map to.
  const [pfAccounts, pfCategories, existingMapping] = await Promise.all([
    getAccounts(userId, { includeArchived: false }),
    getCategories(userId),
    loadConnectorMapping(userId, CONNECTOR_ID),
  ]);

  return NextResponse.json({
    external: {
      accounts: wpAccounts,
      categories: wpCategories,
      sampleTransactions: samplePage,
    },
    finlynq: {
      accounts: pfAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        currency: a.currency,
        group: a.group,
      })),
      categories: pfCategories.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        group: c.group,
      })),
    },
    mapping: existingMapping,
  });
}
