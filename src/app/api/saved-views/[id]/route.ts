/**
 * /api/saved-views/[id] — one saved report or Transactions view (GH #427).
 *
 *   PUT    { name?, config?, isDefault? } → { view }   (rename / save changes /
 *          set or clear the default; 409 `duplicate_name` for a taken name)
 *   DELETE → { deleted: true, id }
 *
 * Rules in src/lib/saved-views/store.ts.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { deleteSavedView, updateSavedView } from "@/lib/saved-views/store";
import { savedViewWriteFailure } from "../_response";

export const dynamic = "force-dynamic";

function viewIdFrom(request: NextRequest): number | null {
  const last = request.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
  const id = Number(last);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const patchSchema = z
  .object({
    name: z.string().max(200).optional(),
    config: z.unknown().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.config !== undefined || b.isDefault !== undefined, {
    message: "Nothing to change.",
  });

export const PUT = apiHandler({ auth: "encryption", body: patchSchema }, async ({ request, userId, dek, body }) => {
  const id = viewIdFrom(request as NextRequest);
  if (id == null) return apiError("No such saved view.", 404);
  const result = await updateSavedView(userId, dek!, id, body);
  if (!result.ok) return savedViewWriteFailure(result);
  return { view: result.view };
});

// Deleting needs no key (it reads nothing encrypted), but it is a write: keep
// it behind the same gate as the other writes so a locked session can't
// change the list it can't read.
export const DELETE = apiHandler({ auth: "encryption" }, async ({ request, userId }) => {
  const id = viewIdFrom(request as NextRequest);
  if (id == null) return apiError("No such saved view.", 404);
  const deleted = await deleteSavedView(userId, id);
  if (!deleted) return apiError("No such saved view.", 404);
  return { deleted: true, id };
});
