// SimpleFIN bank-feed connector — public surface.
//
// Usage:
//   import { simplefin } from "@finlynq/import-connectors";
//   const accessUrl = await simplefin.exchangeSetupToken(setupToken);
//   const client = new simplefin.SimpleFINClient(accessUrl);
//   const resp = await client.fetchAccounts({ startDate });
//   const { accounts } = simplefin.simplefinToRawTransactions(resp);
//
// Unlike the file-based connectors (Money Pro / Generic CSV), SimpleFIN is a
// LIVE feed: the orchestrator exchanges a setup token for an access URL, stores
// it encrypted under the user's DEK, and pulls on demand.

import type { ConnectorMetadata } from "../types";

export const metadata: ConnectorMetadata = {
  id: "simplefin",
  displayName: "SimpleFIN",
  homepage: "https://www.simplefin.org",
  credentialFields: [
    { key: "setupToken", label: "Setup token", type: "password" },
  ],
  rateLimit: { requestsPerSecond: 1 },
};

export {
  exchangeSetupToken,
  SimpleFINClient,
  SimpleFinApiError,
  SimpleFinSetupTokenError,
  type FetchAccountsOptions,
} from "./client";

export {
  simplefinToRawTransactions,
  epochToISODate,
  type SimpleFinAccountsResponse,
  type SimpleFinAccount,
  type SimpleFinTransaction,
  type SimplefinAccountRows,
  type SimplefinTransformResult,
  type SimplefinTransformOptions,
} from "./transform";
