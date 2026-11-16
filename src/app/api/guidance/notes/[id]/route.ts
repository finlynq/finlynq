/**
 * /api/guidance/notes/[id] — one guidance note (FINLYNQ-219).
 *
 *   GET    → { note, history }  (the active note with its body + every revision)
 *   DELETE { expectedVersion } → retires it (hidden from the index, history kept)
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { noteHistory, readNote, retireNote } from "@/lib/guides/notes-store";
import { noteWriteFailure } from "../_response";

export const dynamic = "force-dynamic";

function noteIdFrom(request: NextRequest): number | null {
  const last = request.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
  const id = Number(last);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const GET = apiHandler({ auth: "encryption" }, async ({ request, userId, dek }) => {
  const id = noteIdFrom(request as NextRequest);
  if (id == null) return apiError("Unknown note.", 404);
  const note = await readNote(userId, dek!, { id });
  if (!note) return apiError("No such note.", 404);
  return { note, history: await noteHistory(userId, dek!, id) };
});

export const DELETE = apiHandler(
  { auth: "encryption", body: z.object({ expectedVersion: z.number().int().positive() }) },
  async ({ request, userId, dek, body }) => {
    const id = noteIdFrom(request as NextRequest);
    if (id == null) return apiError("Unknown note.", 404);
    const result = await retireNote(userId, dek!, { id, expectedVersion: body.expectedVersion, by: "user" });
    if (!result.ok) return noteWriteFailure(result);
    return { retired: true, id };
  },
);
