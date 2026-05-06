/**
 * POST /api/import/staged/[id]/approve
 *
 * Materialize staged rows into the encrypted `transactions` table using the
 * user's logged-in session DEK, then delete the staged import (cascades to
 * staged_transactions).
 *
 * Body (all optional):
 *   {
 *     "rowIds":              string[]   // subset of staged_transactions.id to import; omit = all
 *     "forceImportIndices":  number[]   // row indices to import even if dedup flags them (see executeImport)
 *   }
 *
 * Requires an encryption-capable session (DEK present). Returns 423 if the
 * DEK cache is empty (post-deploy), prompting the client to re-login.
 *
 * The staged_imports row is hard-deleted on success so it disappears from
 * /import/pending immediately. Rejects use DELETE /api/import/staged/[id].
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, inArray, asc } from "drizzle-orm";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { executeImport, type RawTransaction } from "@/lib/import-pipeline";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { sourceTagFor, isFormatTag, type FormatTag } from "@/lib/tx-source";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  // Body is optional — default = import everything.
  let rowIds: string[] | undefined;
  let forceImportIndices: number[] = [];
  try {
    const body = await request.json() as { rowIds?: unknown; forceImportIndices?: unknown };
    if (Array.isArray(body.rowIds)) {
      rowIds = body.rowIds.filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(body.forceImportIndices)) {
      forceImportIndices = body.forceImportIndices.filter((x): x is number => typeof x === "number");
    }
  } catch {
    // no body / invalid JSON → import everything
  }

  // Verify ownership — staged_imports must belong to this user.
  const staged = await db
    .select({
      id: schema.stagedImports.id,
      source: schema.stagedImports.source,
      fileFormat: schema.stagedImports.fileFormat,
    })
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
      eq(schema.stagedImports.status, "pending"),
    ))
    .get();
  if (!staged) {
    return NextResponse.json({ error: "Not found or already processed" }, { status: 404 });
  }

  // Load staged rows, filtered by rowIds if provided.
  const allRows = await db
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.stagedImportId, id))
    .orderBy(asc(schema.stagedTransactions.rowIndex))
    .all();

  const selected = rowIds
    ? allRows.filter((r) => rowIds!.includes(r.id))
    : allRows;

  if (selected.length === 0) {
    return NextResponse.json({ error: "No rows selected" }, { status: 400 });
  }

  // Shape for executeImport. Decrypt the staging-envelope fields before
  // passing to the pipeline — the pipeline expects plaintext and then
  // re-encrypts under the user's DEK inside `transactions`.
  //
  // Tier branching (2026-05-06): rows can be at 'service' tier (sv1: under
  // PF_STAGING_KEY) or 'user' tier (v1: under this user's DEK), depending on
  // whether the login-time upgrade job has run yet. tryDecryptField returns
  // null on auth-tag failure (load-bearing per CLAUDE.md) — null fields fall
  // back to "" / undefined the same way they did pre-tier.
  //
  // Issue #62: stamp source:<format> so cross-source dedup can identify
  // where the row arrived from. The staged_imports/staged_transactions tables
  // don't carry `tags`, so we apply at materialize time. Issue #153: tag
  // varies by file_format/source so uploads (CSV/OFX/QFX) get
  // `source:csv|ofx|qfx` instead of always-`source:email`.
  //
  // Mapping:
  //   staged_imports.source='email'  → 'source:email' (Resend Inbound)
  //   staged_imports.file_format=X   → 'source:X' when X is a known FormatTag
  //   else                           → fall back to 'source:email' for safety
  const sourceTag = (() => {
    if (staged.source === "email") return sourceTagFor("email");
    const ff = staged.fileFormat;
    if (ff && isFormatTag(ff)) return sourceTagFor(ff as FormatTag);
    // 'xlsx' file_format (when added) maps to FormatTag 'excel'.
    if (ff === "xlsx") return sourceTagFor("excel");
    return sourceTagFor("email");
  })();
  const decode = (value: string | null, tier: string): string | null => {
    if (value == null) return null;
    return tier === "user" ? tryDecryptField(dek, value) : decryptStaged(value);
  };
  // Preserve any tags the upload route stamped on the staged row (today's
  // upload route doesn't set them; future upload paths might). The source
  // tag is appended after, dedup-on-substring keeps it idempotent.
  const mergeTags = (existing: string | null | undefined, tag: string): string => {
    const list = (existing ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t);
    if (list.some((t) => t.toLowerCase() === tag.toLowerCase())) return list.join(",");
    list.push(tag);
    return list.join(",");
  };
  const rows: RawTransaction[] = selected.map((r) => ({
    date: r.date,
    account: decode(r.accountName, r.encryptionTier) ?? "",
    amount: r.amount,
    payee: decode(r.payee, r.encryptionTier) ?? "",
    category: decode(r.category, r.encryptionTier) ?? undefined,
    currency: r.currency ?? undefined,
    note: decode(r.note, r.encryptionTier) ?? undefined,
    tags: mergeTags(r.tags, sourceTag),
  }));

  const result = await executeImport(rows, forceImportIndices, userId, dek);
  if ((result.imported ?? 0) > 0) invalidateUserTxCache(userId);

  // Delete the staged import — rows cascade via FK ON DELETE CASCADE.
  // Scope to user again defensively even though we verified ownership above.
  if (rowIds && rowIds.length < allRows.length) {
    // Partial approve — only delete the rows we imported; leave the rest for
    // a subsequent approve/reject. Update the total count on staged_imports
    // so the UI reflects the remaining work.
    await db.delete(schema.stagedTransactions)
      .where(and(
        eq(schema.stagedTransactions.stagedImportId, id),
        inArray(schema.stagedTransactions.id, selected.map((r) => r.id)),
      ));

    const remaining = allRows.length - selected.length;
    if (remaining === 0) {
      await db.delete(schema.stagedImports)
        .where(and(
          eq(schema.stagedImports.id, id),
          eq(schema.stagedImports.userId, userId),
        ));
    } else {
      // Update total + dup counts (dup count recomputed from remaining rows).
      const remainingRows = allRows.filter((r) => !rowIds!.includes(r.id));
      const newDupCount = remainingRows.filter((r) => r.isDuplicate).length;
      await db.update(schema.stagedImports)
        .set({
          totalRowCount: remaining,
          duplicateCount: newDupCount,
        })
        .where(and(
          eq(schema.stagedImports.id, id),
          eq(schema.stagedImports.userId, userId),
        ));
    }
  } else {
    // Full approve — drop the whole staged import (cascade).
    await db.delete(schema.stagedImports)
      .where(and(
        eq(schema.stagedImports.id, id),
        eq(schema.stagedImports.userId, userId),
      ));
  }

  return NextResponse.json(result);
}
