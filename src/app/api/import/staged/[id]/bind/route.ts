/**
 * PATCH /api/import/staged/[id]/bind
 *
 * Lightweight manual-pick fallback for email-import batches that didn't
 * template-match at parse time (2026-05-28). Surfaces from the
 * /import/pending detail page's picker when staged_imports.boundAccountId
 * IS NULL AND staged_imports.headers IS NOT NULL.
 *
 * Body (exactly one of accountId / templateId):
 *   { accountId: number }        // bind to an account directly
 *   { templateId: number }       // apply a template's defaultAccount
 *
 * Behavior:
 *   - Resolves the body to an accountId + a decrypted account name.
 *     - accountId path: validates the FK belongs to this user.
 *     - templateId path: loads template, takes its defaultAccount string,
 *       finds the matching account by case-insensitive decrypted name OR
 *       alias. 400 if no match.
 *   - UPDATEs staged_imports.boundAccountId.
 *   - UPDATEs every staged_transactions row in the batch: rewrites
 *     account_name to the chosen account's decrypted name, re-encrypted
 *     at each row's existing encryption_tier (matches the per-row PATCH
 *     pattern). Rows with no payee/note untouched.
 *   - Returns { ok: true, accountId, accountName, rowsRebound }.
 *
 * Out of scope (deliberately):
 *   - Re-parsing rows with the template's column mapping. The staged rows
 *     already have parsed amounts + dates from the auto-detect at email
 *     time. If the auto-detect got it wrong, the user discards + resends.
 *     Recovering from a bad parse requires keeping the raw bytes, which
 *     this lightweight pass does not.
 *   - Re-running dedup. The bank-side dedup runs at /reconcile materialize
 *     time off the import_hash (which was computed at ingest from the
 *     plaintext payee — load-bearing invariant). Binding to an account
 *     doesn't change the hash, so dedup is unaffected.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { encryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField, encryptField } from "@/lib/crypto/envelope";

export const dynamic = "force-dynamic";

const BodySchema = z
  .object({
    accountId: z.number().int().positive().optional(),
    templateId: z.number().int().positive().optional(),
  })
  .refine(
    (b) => (b.accountId == null) !== (b.templateId == null),
    { message: "Provide exactly one of accountId or templateId" },
  );

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch (e) {
    const message = e instanceof z.ZodError ? e.issues[0]?.message ?? "Invalid body" : "Invalid body";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Ownership check on the staged_imports row. Cross-tenant attempts get
  // 404 — same shape as the rest of the staging API surface.
  const staged = await db
    .select({
      id: schema.stagedImports.id,
      status: schema.stagedImports.status,
    })
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ))
    .get();
  if (!staged) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (staged.status !== "pending") {
    return NextResponse.json(
      { error: `Cannot bind a staged_import in status '${staged.status}'` },
      { status: 409 },
    );
  }

  // Resolve to an accountId + plain name.
  let resolvedAccountId: number | null = null;
  let resolvedAccountName: string | null = null;

  if (body.accountId != null) {
    const acct = await db
      .select({ id: schema.accounts.id, nameCt: schema.accounts.nameCt })
      .from(schema.accounts)
      .where(and(
        eq(schema.accounts.id, body.accountId),
        eq(schema.accounts.userId, userId),
      ))
      .get();
    if (!acct) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    resolvedAccountId = acct.id;
    resolvedAccountName = acct.nameCt
      ? tryDecryptField(dek, acct.nameCt, "accounts.name_ct") ?? null
      : null;
    if (!resolvedAccountName) {
      // Without a decrypted name we can't write account_name on staged
      // rows. Surface a clear error rather than writing garbage.
      return NextResponse.json(
        { error: "Account name could not be decrypted" },
        { status: 500 },
      );
    }
  } else if (body.templateId != null) {
    const tmpl = await db
      .select({
        id: schema.importTemplates.id,
        defaultAccount: schema.importTemplates.defaultAccount,
      })
      .from(schema.importTemplates)
      .where(and(
        eq(schema.importTemplates.id, body.templateId),
        eq(schema.importTemplates.userId, userId),
      ))
      .get();
    if (!tmpl) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
    if (!tmpl.defaultAccount) {
      return NextResponse.json(
        { error: "Template has no default account — bind to an account directly instead" },
        { status: 400 },
      );
    }
    // Find the account by case-insensitive decrypted-name match. Mirrors
    // the approve route's lookup pattern. Stream D Phase 4 — we have to
    // decrypt every account to compare; no plaintext column to filter on.
    const acctRows = await db
      .select({
        id: schema.accounts.id,
        nameCt: schema.accounts.nameCt,
        aliasCt: schema.accounts.aliasCt,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, userId))
      .all();
    const targetKey = tmpl.defaultAccount.toLowerCase().trim();
    for (const a of acctRows) {
      const plainName = a.nameCt ? tryDecryptField(dek, a.nameCt, "accounts.name_ct") : null;
      const plainAlias = a.aliasCt ? tryDecryptField(dek, a.aliasCt, "accounts.alias_ct") : null;
      if (
        (plainName && plainName.toLowerCase().trim() === targetKey) ||
        (plainAlias && plainAlias.toLowerCase().trim() === targetKey)
      ) {
        resolvedAccountId = a.id;
        resolvedAccountName = plainName ?? tmpl.defaultAccount;
        break;
      }
    }
    if (resolvedAccountId == null) {
      return NextResponse.json(
        {
          error: `Template's default account "${tmpl.defaultAccount}" not found in your accounts. Create it first, or bind to an account directly.`,
        },
        { status: 400 },
      );
    }
  }

  if (resolvedAccountId == null || resolvedAccountName == null) {
    // Should be unreachable given the refine() guard, but keep the
    // type-narrowing happy.
    return NextResponse.json({ error: "Resolution failed" }, { status: 500 });
  }

  // ─── Apply the binding ────────────────────────────────────────────────
  // 1. Update staged_imports.bound_account_id
  await db
    .update(schema.stagedImports)
    .set({ boundAccountId: resolvedAccountId })
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ));

  // 2. Update staged_transactions.account_name per row, re-encrypted at
  //    the row's existing tier. Pulling rows first lets us branch per
  //    tier without two passes; staged batches max out around a few
  //    hundred rows so this is cheap.
  const stagedRows = await db
    .select({
      id: schema.stagedTransactions.id,
      encryptionTier: schema.stagedTransactions.encryptionTier,
    })
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.stagedImportId, id))
    .all();

  let rowsRebound = 0;
  for (const row of stagedRows) {
    const newAccountNameCt =
      row.encryptionTier === "user"
        ? encryptField(dek, resolvedAccountName)
        : encryptStaged(resolvedAccountName);
    await db
      .update(schema.stagedTransactions)
      .set({ accountName: newAccountNameCt })
      .where(and(
        eq(schema.stagedTransactions.id, row.id),
        eq(schema.stagedTransactions.userId, userId),
      ));
    rowsRebound++;
  }

  return NextResponse.json({
    ok: true,
    accountId: resolvedAccountId,
    accountName: resolvedAccountName,
    rowsRebound,
  });
}
