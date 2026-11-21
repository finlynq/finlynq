/**
 * /api/subscriptions/dismissals — payees marked "Not a subscription" (GH #428).
 *
 *   GET    → { dismissals: [{ id, payee, createdAt }], locked }
 *   POST   { payees: string[] } → { added }   (idempotent)
 *   DELETE { ids?: number[], payees?: string[] } → { removed }   (undo)
 *
 * Rules live in src/lib/subscriptions/dismissals.ts, shared with MCP
 * manage_subscriptions.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import {
  DismissalError,
  MAX_DISMISSALS_PER_CALL,
  dismissPayees,
  listDismissals,
  undismiss,
} from "@/lib/subscriptions/dismissals";

export const dynamic = "force-dynamic";

const mapError = (err: unknown) =>
  err instanceof DismissalError
    ? NextResponse.json({ success: false, error: err.message }, { status: 400 })
    : null;

export const GET = apiHandler({ auth: "auth" }, async ({ userId, dek }) => ({
  dismissals: await listDismissals(userId, dek),
  locked: !dek,
}));

const dismissSchema = z.object({
  payees: z.array(z.string().max(300)).min(1).max(MAX_DISMISSALS_PER_CALL),
});

export const POST = apiHandler(
  { auth: "encryption", body: dismissSchema, mapError },
  async ({ userId, dek, body }) => dismissPayees(userId, dek!, body.payees),
);

const undoSchema = z.object({
  ids: z.array(z.number().int().positive()).max(MAX_DISMISSALS_PER_CALL).optional(),
  payees: z.array(z.string().max(300)).max(MAX_DISMISSALS_PER_CALL).optional(),
});

export const DELETE = apiHandler(
  { auth: "auth", body: undoSchema, mapError },
  async ({ userId, dek, body }) => undismiss(userId, dek, body),
);
