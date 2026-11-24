/**
 * /api/payees — the payee list behind the Payee field's suggestions.
 *
 *   GET    → { payees: [{ id, name, count, categoryId }], locked }
 *   DELETE { id } → { removed }   (take one out of the suggestions)
 *
 * Payees are added by the transaction routes and MCP as transactions are
 * saved; there is no POST. Store: src/lib/payees/store.ts.
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { forgetPayee, listPayees } from "@/lib/payees/store";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ userId, dek }) => ({
  payees: await listPayees(userId, dek),
  locked: !dek,
}));

const forgetSchema = z.object({ id: z.number().int().positive() });

export const DELETE = apiHandler(
  { auth: "auth", body: forgetSchema },
  async ({ userId, body }) => forgetPayee(userId, body.id),
);
