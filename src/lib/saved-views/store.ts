/**
 * SERVER ONLY (reaches the database): never import into a client component.
 *
 * Saved reports and saved Transactions views (GH #427): the ONE place they
 * are read and written. REST (`/api/saved-views`, the Reports and
 * Transactions pages) and MCP (`get_saved_views`) both call these functions.
 *
 * The name and the config are encrypted with the user's DEK (the config holds
 * account ids, tag names and search text), so writes need the DEK. Reads take
 * a nullable DEK: a row this key can't decrypt (no key, or written under a
 * different one) comes back `unreadable: true` with no name or config.
 * Configs are validated by kind with the pure schemas in config.ts and stored
 * normalized; dates stay relative (see config.ts).
 */

import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db, schema, withDbTransaction } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { buildNameFields, nameLookup } from "@/lib/crypto/encrypted-columns";
import { pgErrorCode, pgErrorConstraint } from "@/lib/db-utils";
import {
  SAVED_VIEWS_MAX_PER_KIND,
  checkSavedViewName,
  parseSavedViewConfig,
  type SavedView,
  type SavedViewConfig,
  type SavedViewKind,
} from "./config";

const views = schema.savedViews;

export type { SavedView };

export type SavedViewWriteResult =
  | { ok: true; view: SavedView }
  | { ok: false; code: "invalid" | "duplicate_name" | "too_many" | "not_found"; error: string };

type Row = typeof views.$inferSelect;

function toView(dek: Buffer | null, r: Row): SavedView {
  const name = dek ? tryDecryptField(dek, r.nameCt, "saved-view-name") : null;
  const json = dek ? tryDecryptField(dek, r.configCt, "saved-view-config") : null;
  let config: SavedViewConfig | null = null;
  if (json != null) {
    try {
      const parsed = parseSavedViewConfig(r.kind, JSON.parse(json));
      config = parsed.ok ? parsed.config : null;
    } catch {
      config = null;
    }
  }
  return {
    id: r.id,
    kind: r.kind,
    name: name ?? "",
    config,
    isDefault: r.isDefault,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    unreadable: name == null || json == null,
  };
}

function duplicateName(): SavedViewWriteResult {
  return { ok: false, code: "duplicate_name", error: "You already have one with that name. Pick another name." };
}

function isUniqueNameViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505" && pgErrorConstraint(err) === "saved_views_user_kind_name_unique";
}

/** A user's saved views, optionally of one kind, sorted by name. */
export async function listSavedViews(
  userId: string,
  dek: Buffer | null,
  kind?: SavedViewKind,
): Promise<SavedView[]> {
  const where = kind ? and(eq(views.userId, userId), eq(views.kind, kind)) : eq(views.userId, userId);
  const rows = await db.select().from(views).where(where).orderBy(asc(views.id));
  return rows
    .map((r) => toView(dek, r))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** One saved view, or null (scoped to the user). */
export async function getSavedView(userId: string, dek: Buffer | null, id: number): Promise<SavedView | null> {
  const [row] = await db
    .select()
    .from(views)
    .where(and(eq(views.userId, userId), eq(views.id, id)))
    .limit(1);
  return row ? toView(dek, row) : null;
}

/** Clear the user's other default of `kind` (call inside the write's transaction). */
async function clearOtherDefaults(userId: string, kind: SavedViewKind, keepId: number | null) {
  const where = keepId == null
    ? and(eq(views.userId, userId), eq(views.kind, kind), eq(views.isDefault, true))
    : and(eq(views.userId, userId), eq(views.kind, kind), eq(views.isDefault, true), ne(views.id, keepId));
  await db.update(views).set({ isDefault: false, updatedAt: new Date() }).where(where);
}

export interface SavedViewDraft {
  kind: SavedViewKind;
  name: string;
  config: unknown;
  isDefault?: boolean;
}

/** Save a new view. */
export async function createSavedView(userId: string, dek: Buffer, draft: SavedViewDraft): Promise<SavedViewWriteResult> {
  const name = checkSavedViewName(draft.name);
  if (!name.ok) return { ok: false, code: "invalid", error: name.error };
  const config = parseSavedViewConfig(draft.kind, draft.config);
  if (!config.ok) return { ok: false, code: "invalid", error: config.error };
  const isDefault = !!draft.isDefault;
  if (isDefault && draft.kind !== "transactions") {
    return { ok: false, code: "invalid", error: "Only a Transactions view can open by default." };
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(views)
    .where(and(eq(views.userId, userId), eq(views.kind, draft.kind)));
  if (Number(count) >= SAVED_VIEWS_MAX_PER_KIND) {
    return { ok: false, code: "too_many", error: `You can keep up to ${SAVED_VIEWS_MAX_PER_KIND}. Delete one first.` };
  }

  const nameFields = buildNameFields(dek, { name: name.name }) as { nameCt: string; nameLookup: string };
  try {
    const row = await withDbTransaction(async () => {
      if (isDefault) await clearOtherDefaults(userId, draft.kind, null);
      const [inserted] = await db
        .insert(views)
        .values({
          userId,
          kind: draft.kind,
          nameCt: nameFields.nameCt,
          nameLookup: nameFields.nameLookup,
          configCt: encryptField(dek, JSON.stringify(config.config))!,
          isDefault,
        })
        .returning();
      return inserted;
    });
    return { ok: true, view: toView(dek, row) };
  } catch (err) {
    if (isUniqueNameViolation(err)) return duplicateName();
    throw err;
  }
}

export interface SavedViewPatch {
  name?: string;
  config?: unknown;
  isDefault?: boolean;
}

/** Rename, save changes to, or set/clear the default of one view. */
export async function updateSavedView(
  userId: string,
  dek: Buffer,
  id: number,
  patch: SavedViewPatch,
): Promise<SavedViewWriteResult> {
  const [current] = await db
    .select()
    .from(views)
    .where(and(eq(views.userId, userId), eq(views.id, id)))
    .limit(1);
  if (!current) return { ok: false, code: "not_found", error: "No such saved view." };

  const set: Partial<typeof views.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = checkSavedViewName(patch.name);
    if (!name.ok) return { ok: false, code: "invalid", error: name.error };
    const fields = buildNameFields(dek, { name: name.name }) as { nameCt: string; nameLookup: string };
    set.nameCt = fields.nameCt;
    set.nameLookup = fields.nameLookup;
  }
  if (patch.config !== undefined) {
    const config = parseSavedViewConfig(current.kind, patch.config);
    if (!config.ok) return { ok: false, code: "invalid", error: config.error };
    set.configCt = encryptField(dek, JSON.stringify(config.config))!;
  }
  if (patch.isDefault !== undefined) {
    if (patch.isDefault && current.kind !== "transactions") {
      return { ok: false, code: "invalid", error: "Only a Transactions view can open by default." };
    }
    set.isDefault = patch.isDefault;
  }

  try {
    const row = await withDbTransaction(async () => {
      if (patch.isDefault) await clearOtherDefaults(userId, current.kind, id);
      const [updated] = await db
        .update(views)
        .set(set)
        .where(and(eq(views.userId, userId), eq(views.id, id)))
        .returning();
      return updated;
    });
    if (!row) return { ok: false, code: "not_found", error: "No such saved view." };
    return { ok: true, view: toView(dek, row) };
  } catch (err) {
    if (isUniqueNameViolation(err)) return duplicateName();
    throw err;
  }
}

/** Delete one view. A saved view is only a set of settings, so it is really deleted. */
export async function deleteSavedView(userId: string, id: number): Promise<boolean> {
  const deleted = await db
    .delete(views)
    .where(and(eq(views.userId, userId), eq(views.id, id)))
    .returning({ id: views.id });
  return deleted.length > 0;
}

/** A view by name (case- and spacing-insensitive, via the name HMAC). */
export async function findSavedViewByName(
  userId: string,
  dek: Buffer,
  kind: SavedViewKind | undefined,
  name: string,
): Promise<SavedView[]> {
  const checked = checkSavedViewName(name);
  if (!checked.ok) return [];
  const lookup = nameLookup(dek, checked.name);
  const where = kind
    ? and(eq(views.userId, userId), eq(views.kind, kind), eq(views.nameLookup, lookup))
    : and(eq(views.userId, userId), eq(views.nameLookup, lookup));
  const rows = await db.select().from(views).where(where).orderBy(asc(views.id));
  return rows.map((r) => toView(dek, r));
}
