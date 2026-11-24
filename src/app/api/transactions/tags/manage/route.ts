/**
 * /api/transactions/tags/manage — Settings → Payees & tags, Tags tab.
 *
 *   GET  → { tags: TagUsage[], groups: string[][] (tag names), locked }
 *   POST { sources: string[], target: string | null }
 *        → { updated }   (merge or rename into `target`; null removes them)
 *
 * Changes tags on transactions and their split rows, never on bank rows or
 * pending statement files. Store: src/lib/names/manage.ts.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import {
  MAX_MERGE_SOURCES,
  NameCleanupError,
  listTagUsage,
  replaceTags,
  tagDuplicateGroups,
} from "@/lib/names/manage";

export const dynamic = "force-dynamic";

const mapError = (err: unknown) =>
  err instanceof NameCleanupError
    ? NextResponse.json({ success: false, error: err.message }, { status: 400 })
    : null;

export const GET = apiHandler({ auth: "auth" }, async ({ userId, dek }) => {
  if (!dek) return { tags: [], groups: [], locked: true };
  const tags = await listTagUsage(userId, dek);
  return { tags, groups: tagDuplicateGroups(tags), locked: false };
});

const replaceSchema = z.object({
  sources: z.array(z.string().min(1).max(100)).min(1).max(MAX_MERGE_SOURCES),
  target: z.string().max(100).nullable(),
});

export const POST = apiHandler(
  { auth: "encryption", body: replaceSchema, mapError },
  async ({ userId, dek, body }) => replaceTags(userId, dek!, body.sources, body.target),
);
