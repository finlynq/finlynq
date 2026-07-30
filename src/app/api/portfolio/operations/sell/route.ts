import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { recordSell } from "@/lib/portfolio/operations";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { mapOperationError, replacePortfolioOperation } from "../_helpers";

const schema = z.object({
  accountId: z.number().int().positive(),
  holdingId: z.number().int().positive(),
  qty: z.number().positive(),
  totalProceeds: z.number().positive(),
  date: z.string(),
  payee: z.string().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
  cashSleeveHoldingId: z.number().int().positive().optional(),
  lotSelection: z
    .object({
      // Mirrors LotSelectionStrategy in src/lib/portfolio/lots/types.ts —
      // HIFO (Highest-in-first-out), NOT LIFO. FIFO is the default when
      // omitted; SPECIFIC requires lotIds (legacy) OR lots (Phase 3 per-lot qty).
      method: z.enum(["FIFO", "HIFO", "SPECIFIC"]),
      lotIds: z.array(z.number().int().positive()).optional(),
      lots: z
        .array(
          z.object({
            lotId: z.number().int().positive(),
            qty: z.number().positive(),
          }),
        )
        .optional(),
    })
    .optional(),
  // Phase 2 edit-as-replace (2026-05-25 follow-up). When set, cascade-deletes
  // the existing pair (via trade_link_id) before creating the new one.
  editId: z.number().int().positive().optional(),
});

// raw/compat mode — bare-shape consumers (web forms + mobile). See buy/route.ts.
export const POST = apiHandler(
  {
    auth: "encryption",
    body: schema,
    raw: true,
    mapError: mapOperationError,
    fallbackMessage: "Failed to record sell",
  },
  async ({ userId, dek, body }) => {
    const { editId, ...input } = body;
    // Edit-as-replace runs the cascade-delete AND the record in ONE
    // transaction (`replacePortfolioOperation`) — a validation failure
    // here used to destroy the original pair. See ../_helpers.ts.
    const record = () => recordSell({
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
