/**
 * POST /api/rules/catch-all — one-click catch-all rule (GH #456).
 *
 * Finds or makes the "Uncategorized" category and adds an ordinary rule at the
 * lowest priority that files anything no other rule matched under it. Returns
 * the existing rule (created: false) when the user already has one.
 * Logic: src/lib/rules/catch-all-server.ts.
 */
import { apiHandler } from "@/lib/api-handler";
import { createCatchAllRule } from "@/lib/rules/catch-all-server";

export const dynamic = "force-dynamic";

export const POST = apiHandler({ auth: "encryption" }, async ({ userId, dek }) =>
  createCatchAllRule(userId, dek as Buffer),
);
