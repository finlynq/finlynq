/**
 * MCP Tools — PostgreSQL / managed-cloud implementation
 *
 * FINLYNQ-109: this file was decomposed from a 12,790-line monolith into a
 * thin composer. Every `server.tool(...)` registration now lives in a
 * per-domain module under `mcp-server/tools/<group>.ts`; each exports a
 * `registerXTools(server, ctx)` that registers its group. The shared closure
 * state (db/userId/dek + the note encrypt/decrypt helpers) is built once here
 * into a `PgToolContext` and handed to each group. Shared pure helpers +
 * the collapsed generic `resolveStrict` live in `mcp-server/tools/_shared.ts`;
 * the portfolio aggregator moved to `src/lib/portfolio/aggregate-holdings.ts`.
 *
 * All queries stay async, user-scoped, and use Drizzle's `sql` template so
 * they work with either the pg or neon-http drivers.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encryptField, tryDecryptField } from "../src/lib/crypto/envelope";
import type { DbLike, PgToolContext } from "./tools/_shared";

// Per-group tool registrars (FINLYNQ-109).
import { registerReadsTools } from "./tools/reads";
import { registerAccountsTools } from "./tools/accounts";
import { registerTransactionsTools } from "./tools/transactions";
import { registerGoalsTools } from "./tools/goals";
import { registerPortfolioTools } from "./tools/portfolio";
import { registerCategoriesTools } from "./tools/categories";
import { registerRulesTools } from "./tools/rules";
import { registerLoansTools } from "./tools/loans";
import { registerFxTools } from "./tools/fx";
import { registerSubscriptionsTools } from "./tools/subscriptions";
import { registerImportsTools } from "./tools/imports";
import { registerReconcileTools } from "./tools/reconcile";

// Re-exported for the FINLYNQ-65 / parity regression tests, which import
// `aggregateHoldings` from this module. The implementation moved to the lib
// under FINLYNQ-109; the re-export keeps those imports resolving unchanged.
export { aggregateHoldings } from "../src/lib/portfolio/aggregate-holdings";

export function registerPgTools(
  server: McpServer,
  db: DbLike,
  userId: string,
  dek: Buffer | null = null
) {
  // Phase 2 (2026-06-01) — free-text note/notes columns are user-DEK encrypted
  // at rest. DEK is in scope for every HTTP tool (same as the transaction-note
  // path). Cold-DEK writes pass plaintext through (login sweep cleans up);
  // reads tolerate both ciphertext and legacy plaintext.
  // plan/encryption-plaintext-gaps.md
  const encNote = (v: string | null | undefined): string =>
    (dek ? encryptField(dek, v ?? "") : (v ?? "")) ?? "";
  const decNote = (v: string | null | undefined): string | null => {
    if (v == null || v === "") return v ?? null;
    if (!dek) return v;
    return tryDecryptField(dek, v) ?? v;
  };

  const ctx: PgToolContext = { db, userId, dek, encNote, decNote };

  registerReadsTools(server, ctx);
  registerAccountsTools(server, ctx);
  registerTransactionsTools(server, ctx);
  registerGoalsTools(server, ctx);
  registerPortfolioTools(server, ctx);
  registerCategoriesTools(server, ctx);
  registerRulesTools(server, ctx);
  registerLoansTools(server, ctx);
  registerFxTools(server, ctx);
  registerSubscriptionsTools(server, ctx);
  registerImportsTools(server, ctx);
  registerReconcileTools(server, ctx);
}
