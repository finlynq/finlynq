/**
 * /api/payees/manage — Settings → Payees & tags, Payees tab.
 *
 *   GET  → { payees: PayeeUsage[], groups: string[][] (keys), locked }
 *   POST { sources: string[] (keys), target, addImportRules? }
 *        → { updated, rulesAdded }   (merge; a rename is a merge of one)
 *   POST { action: "to_note", sources } → { updated }
 *        (move the payee text into the note, leave the payee empty)
 *
 * Changes the payee on transactions only, never on bank rows or pending
 * statement files. Store: src/lib/names/manage.ts.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import {
  MAX_MERGE_SOURCES,
  NameCleanupError,
  listPayeeUsage,
  mergePayees,
  movePayeesToNote,
  payeeDuplicateGroups,
} from "@/lib/names/manage";
import { PAYEE_MAX_LENGTH } from "@/lib/payees/suggest";

export const dynamic = "force-dynamic";

const mapError = (err: unknown) =>
  err instanceof NameCleanupError
    ? NextResponse.json({ success: false, error: err.message }, { status: 400 })
    : null;

export const GET = apiHandler({ auth: "auth" }, async ({ userId, dek }) => {
  if (!dek) return { payees: [], groups: [], locked: true };
  const payees = await listPayeeUsage(userId, dek);
  return { payees, groups: payeeDuplicateGroups(payees), locked: false };
});

const sourcesSchema = z.array(z.string().min(1).max(100)).min(1).max(MAX_MERGE_SOURCES);
const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("merge"),
    sources: sourcesSchema,
    target: z.string().min(1).max(PAYEE_MAX_LENGTH),
    addImportRules: z.boolean().optional(),
  }),
  z.object({ action: z.literal("to_note"), sources: sourcesSchema }),
]);

export const POST = apiHandler(
  {
    auth: "encryption",
    // No action = merge (the first shape of this route).
    body: z.preprocess(
      (v) => (v && typeof v === "object" && !("action" in v) ? { ...v, action: "merge" } : v),
      postSchema,
    ),
    mapError,
  },
  async ({ userId, dek, body }) =>
    body.action === "to_note"
      ? movePayeesToNote(userId, dek!, body.sources)
      : mergePayees(userId, dek!, body.sources, body.target, body.addImportRules ?? false),
);
