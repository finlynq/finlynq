// IBKR connector orchestrator (pure — no DB, no encryption).
//
// Responsibility:
//   1. Auto-detect XML vs CSV input.
//   2. Parse → IbkrParsedFile.
//   3. Run the IB-specific transform → ExternalAccount/ExternalCategory/
//      ExternalTransaction inventories.
//   4. Hand them to the standard transformTransactions() pipeline (shared
//      with WealthPosition's API path), which uses the resolved mapping
//      from the user to produce the import-pipeline-ready TransformResult.
//
// Side effects (DB writes, credential storage, dedup against existing
// Finlynq state) live in the Finlynq-side glue under
// `src/lib/external-import/`. This file is pure and `npm publish`-safe.

import type {
  ConnectorMappingResolved,
  TransformResult,
} from "../types";
import { transformTransactions } from "../wealthposition/transform";
import { parseFlexCsv } from "./parse-csv";
import { parseFlexXml } from "./parse-xml";
import { transformIbkrFile } from "./transform";

export interface IbkrRunOptions {
  /** Raw file body — either Flex XML or Activity CSV. */
  fileBody: string;
  /** Force a format. Otherwise sniffed by file shape. */
  format?: "xml" | "csv";
}

/** Sniff format from first few hundred chars. */
export function detectFormat(text: string): "xml" | "csv" {
  const head = text.trimStart().slice(0, 200);
  if (head.startsWith("<")) return "xml";
  return "csv";
}

/**
 * Full orchestrator entry point. Returns the TransformResult shape the
 * import pipeline expects — same as WealthPosition's API path.
 *
 * The mapping must already include external account ids of the form
 * `ibkr:acct:<accountId>:<currency>` and external holding-pseudo-account ids
 * of the form `ibkr:holding:<symbol>` resolved to Finlynq account ids; plus
 * the standard category map for the synthetic `ibkr:cat:*` ids.
 */
export function runIbkrTransform(
  opts: IbkrRunOptions,
  mapping: ConnectorMappingResolved,
): TransformResult {
  const fmt = opts.format ?? detectFormat(opts.fileBody);
  const parsed = fmt === "xml" ? parseFlexXml(opts.fileBody) : parseFlexCsv(opts.fileBody);
  const intermediate = transformIbkrFile(parsed);

  // Build the byName lookups the standard transform needs. We treat
  // holding pseudo-accounts as accounts so a trade's holding leg routes
  // through the user-mapped Finlynq target (typically the same brokerage
  // account as the cash leg, which is what the orchestrator will default to
  // when materializing the mapping).
  const externalAccountByName = new Map<string, string>();
  for (const a of [...intermediate.accounts, ...intermediate.holdingPseudoAccounts]) {
    externalAccountByName.set(a.name, a.id);
  }
  const externalCategoryByName = new Map<string, string>();
  for (const c of intermediate.categories) {
    externalCategoryByName.set(c.name, c.id);
  }

  return transformTransactions(
    intermediate.transactions,
    mapping,
    { externalAccountByName, externalCategoryByName },
    { sourceConnectorId: "ibkr" },
  );
}
