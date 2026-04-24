import type {
  Connector,
  ConnectorMappingResolved,
  ConnectorMetadata,
  ExternalTransaction,
  TransformResult,
} from "../types";
import { WealthPositionClient } from "./client";
import { transformTransactions } from "./transform";

export { WealthPositionClient, WealthPositionApiError } from "./client";
export { transformTransactions } from "./transform";
export {
  parseWealthPositionExport,
  transformWealthPositionExport,
  type ZipContents,
  type ParsedExport,
  type ZipTransactionRow,
} from "./zip-parser";
export { parseCsv, parseCsvDicts } from "./csv";

export const metadata: ConnectorMetadata = {
  id: "wealthposition",
  displayName: "WealthPosition",
  homepage: "https://www.wealthposition.com",
  credentialFields: [
    { key: "apiKey", label: "API key", type: "password" },
  ],
  rateLimit: { requestsPerSecond: 1 },
};

export interface WealthPositionCredentials {
  apiKey: string;
}

export function createClient(creds: WealthPositionCredentials) {
  return new WealthPositionClient({ apiKey: creds.apiKey });
}

/** Build the name→external-id lookup maps that transformTransactions needs. */
export function buildByNameLookups(
  mapping: ConnectorMappingResolved,
  externalCategoryById: Map<string, { name: string }>,
) {
  const externalAccountByName = new Map<string, string>();
  for (const [id, acct] of mapping.externalAccountById) {
    externalAccountByName.set(acct.name, id);
  }
  const externalCategoryByName = new Map<string, string>();
  for (const [id, cat] of externalCategoryById) {
    externalCategoryByName.set(cat.name, id);
  }
  return { externalAccountByName, externalCategoryByName };
}

export const wealthposition: Connector<WealthPositionCredentials> = {
  metadata,
  createClient,
  // The Connector interface's transform takes (externalTxs, mapping). We
  // additionally require a byName lookup — handled by the orchestrator by
  // calling buildByNameLookups before invoking transformTransactions. The
  // default export here uses a fallback that builds the byName map from the
  // provided mapping alone (categories won't resolve without passing the
  // external-category map — see transform.test.ts for the expected usage).
  transform(externalTxs: ExternalTransaction[], mapping: ConnectorMappingResolved): TransformResult {
    const byName = {
      externalAccountByName: new Map<string, string>(),
      externalCategoryByName: new Map<string, string>(),
    };
    for (const [id, acct] of mapping.externalAccountById) {
      byName.externalAccountByName.set(acct.name, id);
    }
    return transformTransactions(externalTxs, mapping, byName);
  },
};
