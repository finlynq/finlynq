import type {
  Connector,
  ConnectorMappingResolved,
  ConnectorMetadata,
  ExternalTransaction,
  TransformResult,
} from "../types";
import { transformTransactions } from "../wealthposition/transform";
import { transformIbkrFile } from "./transform";
import { parseFlexCsv } from "./parse-csv";
import { parseFlexXml } from "./parse-xml";

export { parseFlexXml } from "./parse-xml";
export { parseFlexCsv } from "./parse-csv";
export {
  detectFormat,
  runIbkrTransform,
  type IbkrRunOptions,
} from "./orchestrator";
export {
  transformIbkrFile,
  inferAccountMapping,
  netCancellationTriplets,
  ibkrAccountExternalId,
  CATEGORY_DIVIDENDS,
  CATEGORY_WITHHOLDING,
  CATEGORY_INTEREST,
  CATEGORY_FEES,
  CATEGORY_FX_PNL,
  CATEGORY_DEPOSITS,
} from "./transform";
export type {
  IbkrCashTransaction,
  IbkrFxTranslation,
  IbkrOpenPosition,
  IbkrParsedFile,
  IbkrStatement,
  IbkrTrade,
} from "./types";

export const metadata: ConnectorMetadata = {
  id: "ibkr",
  displayName: "Interactive Brokers",
  homepage: "https://www.interactivebrokers.com",
  // IB Flex Web Service uses a (Token, QueryId) pair to fetch statements.
  credentialFields: [
    { key: "flexToken", label: "Flex Web Service token", type: "password" },
    { key: "flexQueryId", label: "Flex Query ID", type: "text" },
  ],
  rateLimit: { requestsPerSecond: 1 },
};

export interface IbkrCredentials {
  flexToken: string;
  flexQueryId: string;
}

/**
 * IB connector default export. Note that `transform()` here matches the
 * generic `Connector<C>` shape — it expects ExternalTransaction[] already
 * built. The IB-specific entry point (where the source is a raw XML/CSV
 * blob) is `runIbkrTransform()` from orchestrator.ts; the orchestrator on
 * the Finlynq side calls that directly.
 */
export const ibkr: Connector<IbkrCredentials> = {
  metadata,
  // No live API client yet — the file-upload path is the v1 surface. Wire
  // a Flex Web Service client later.
  createClient(): never {
    throw new Error(
      "IBKR connector currently runs from uploaded statements only. " +
        "Use runIbkrTransform() with the file body. A Flex Web Service " +
        "client will be added in a follow-up.",
    );
  },
  transform(
    externalTxs: ExternalTransaction[],
    mapping: ConnectorMappingResolved,
  ): TransformResult {
    const byName = {
      externalAccountByName: new Map<string, string>(),
      externalCategoryByName: new Map<string, string>(),
    };
    for (const [id, acct] of mapping.externalAccountById) {
      byName.externalAccountByName.set(acct.name, id);
    }
    return transformTransactions(externalTxs, mapping, byName, {
      sourceConnectorId: "ibkr",
    });
  },
};

/**
 * Convenience wrapper that ties the parse + intermediate transform together
 * — surfaces the ExternalAccount inventory the UI's mapping dialog needs
 * before the user can resolve to Finlynq targets.
 */
export function parseAndInventory(fileBody: string, format?: "xml" | "csv") {
  const detected = format ?? (fileBody.trimStart().startsWith("<") ? "xml" : "csv");
  const parsed = detected === "xml" ? parseFlexXml(fileBody) : parseFlexCsv(fileBody);
  return transformIbkrFile(parsed);
}
