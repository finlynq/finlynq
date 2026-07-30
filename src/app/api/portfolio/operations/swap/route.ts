import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { recordSwap } from "@/lib/portfolio/operations";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { mapOperationError, replacePortfolioOperation } from "../_helpers";

const schema = z.object({
  accountId: z.number().int().positive(),
  sourceHoldingId: z.number().int().positive(),
  sourceQty: z.number().positive(),
  sourceProceeds: z.number().positive(),
  destHoldingId: z.number().int().positive(),
  destQty: z.number().positive(),
  destCost: z.number().positive(),
  date: z.string(),
  payee: z.string().optional(),
  note: z.string().optional(),
  editId: z.number().int().positive().optional(),
});

// raw/compat mode — bare-shape consumers (web forms + mobile). See buy/route.ts.
export const POST = apiHandler(
  {
    auth: "encryption",
    body: schema,
    raw: true,
    mapError: mapOperationError,
    fallbackMessage: "Failed to record swap",
  },
  async ({ userId, dek, body }) => {
    const { editId, ...input } = body;
    // Edit-as-replace runs the cascade-delete AND the record in ONE
    // transaction (`replacePortfolioOperation`) — a validation failure
    // here used to destroy the original pair. See ../_helpers.ts.
    const record = () => recordSwap({
      ...input,
      userId,
      dek,
      source: "manual",
    });
    let result;
    if (editId != null) {
      const replaced = await replacePortfolioOperation(userId, editId, record);
      if (!replaced.ok) return replaced.response;
      result = replaced.result;
    } else {
      result = await record();
    }
    invalidateUserTxCache(userId);
    // Snapshot history is stale from this trade date forward — auto-rebuild.
    await markSnapshotsDirty(userId, input.date);
    return NextResponse.json(
      editId != null ? { ...result, replaced: editId } : result,
      { status: 201 },
    );
  },
);
