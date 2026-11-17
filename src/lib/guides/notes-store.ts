/**
 * SERVER ONLY (reaches the database): never import into a client component.
 *
 * A user's guidance notes (FINLYNQ-219): the ONE place they are read and
 * written. REST (Settings → AI guidance) and MCP (`get_guidance`,
 * `manage_guidance_notes`) both call these functions, so the screen and an
 * assistant cannot disagree.
 *
 * Every function needs the user's DEK: path, title, summary and body are all
 * encrypted, and the path's HMAC (`path_lookup`) is what keeps one active note
 * per path. Saves are version-checked (`expectedVersion`, 0 for a new note) so
 * the user and the assistant can't silently overwrite each other; every save
 * and retire adds a revision. Retiring never deletes.
 */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema, withDbTransaction } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { nameLookup } from "@/lib/crypto/encrypted-columns";
import { pgErrorCode } from "@/lib/db-utils";
import {
  checkNote,
  noteConflictMessage,
  normalizeNotePath,
  NOTE_MAX_ACTIVE,
  type NoteAuthor,
  type NoteDraft,
} from "./notes-rules";

const notes = schema.userGuidanceNotes;
const revisions = schema.userGuidanceNoteRevisions;

export interface NoteSummary {
  id: number;
  path: string;
  title: string;
  summary: string | null;
  version: number;
  updatedBy: NoteAuthor;
  updatedAt: string;
  /** True when this key can't decrypt the note (written under a different key). */
  unreadable: boolean;
}

export interface NoteFull extends NoteSummary {
  body: string;
}

export interface NoteRevision {
  version: number;
  action: "save" | "retire";
  title: string;
  summary: string | null;
  body: string;
  updatedBy: NoteAuthor;
  createdAt: string;
}

export type NoteWriteResult =
  | { ok: true; note: NoteFull }
  | { ok: false; code: "invalid" | "version_conflict" | "too_many" | "not_found"; error: string; currentVersion?: number };

type NoteRow = typeof notes.$inferSelect;

function dec(dek: Buffer, ct: string | null): string | null {
  return ct == null ? null : tryDecryptField(dek, ct, "guidance-note");
}

function toFull(dek: Buffer, r: NoteRow): NoteFull {
  const path = dec(dek, r.pathCt);
  const title = dec(dek, r.titleCt);
  const body = dec(dek, r.bodyCt);
  return {
    id: r.id,
    path: path ?? "",
    title: title ?? "",
    summary: dec(dek, r.summaryCt),
    body: body ?? "",
    version: r.version,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
    unreadable: path == null || title == null || body == null,
  };
}

function toSummary(dek: Buffer, r: NoteRow): NoteSummary {
  const { body: _body, ...rest } = toFull(dek, r);
  return rest;
}

function pathLookup(dek: Buffer, path: string): string {
  return nameLookup(dek, normalizeNotePath(path));
}

/** Active notes, sorted by path. */
export async function listNotes(userId: string, dek: Buffer): Promise<NoteSummary[]> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), isNull(notes.retiredAt)))
    .orderBy(asc(notes.id));
  return rows.map((r) => toSummary(dek, r)).sort((a, b) => a.path.localeCompare(b.path));
}

/** One active note by id or path, or null. */
export async function readNote(
  userId: string,
  dek: Buffer,
  key: { id?: number; path?: string },
): Promise<NoteFull | null> {
  const where =
    key.id != null
      ? and(eq(notes.userId, userId), eq(notes.id, key.id), isNull(notes.retiredAt))
      : key.path
        ? and(eq(notes.userId, userId), eq(notes.pathLookup, pathLookup(dek, key.path)), isNull(notes.retiredAt))
        : null;
  if (!where) return null;
  const [row] = await db.select().from(notes).where(where).limit(1);
  return row ? toFull(dek, row) : null;
}

/** Every revision of a note (newest first). Includes retired notes; scoped to the user. */
export async function noteHistory(userId: string, dek: Buffer, noteId: number): Promise<NoteRevision[]> {
  const rows = await db
    .select()
    .from(revisions)
    .where(and(eq(revisions.userId, userId), eq(revisions.noteId, noteId)))
    .orderBy(desc(revisions.version), desc(revisions.id));
  return rows.map((r) => ({
    version: r.version,
    action: r.action,
    title: dec(dek, r.titleCt) ?? "",
    summary: dec(dek, r.summaryCt),
    body: dec(dek, r.bodyCt) ?? "",
    updatedBy: r.updatedBy,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Create (`expectedVersion` 0) or update (the current version) the note at a
 * path. The path is the note's identity; to rename, save a new note and
 * retire the old one.
 */
export async function saveNote(
  userId: string,
  dek: Buffer,
  input: NoteDraft & { expectedVersion: number; by: NoteAuthor },
): Promise<NoteWriteResult> {
  const checked = checkNote(input);
  if (!checked.ok) return { ok: false, code: "invalid", error: checked.error };
  const n = checked.note;
  const lookup = pathLookup(dek, n.path);
  const enc = {
    pathCt: encryptField(dek, n.path)!,
    titleCt: encryptField(dek, n.title)!,
    summaryCt: n.summary == null ? null : encryptField(dek, n.summary),
    bodyCt: encryptField(dek, n.body)!,
  };

  try {
    return await withDbTransaction(async () => {
      const [current] = await db
        .select()
        .from(notes)
        .where(and(eq(notes.userId, userId), eq(notes.pathLookup, lookup), isNull(notes.retiredAt)))
        .for("update");

      const currentVersion = current?.version ?? 0;
      if (input.expectedVersion !== currentVersion) {
        return {
          ok: false as const,
          code: "version_conflict" as const,
          error: current && input.expectedVersion === 0
            ? `A note called ${n.path} already exists (version ${currentVersion}). Open it and edit it instead.`
            : noteConflictMessage(currentVersion),
          currentVersion,
        };
      }

      let row: NoteRow;
      if (!current) {
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(notes)
          .where(and(eq(notes.userId, userId), isNull(notes.retiredAt)));
        if (count >= NOTE_MAX_ACTIVE) {
          return {
            ok: false as const,
            code: "too_many" as const,
            error: `You already have ${NOTE_MAX_ACTIVE} notes, the most allowed. Retire one you no longer need first.`,
          };
        }
        [row] = await db
          .insert(notes)
          .values({ userId, pathLookup: lookup, ...enc, version: 1, updatedBy: input.by })
          .returning();
      } else {
        [row] = await db
          .update(notes)
          .set({ ...enc, version: current.version + 1, updatedBy: input.by, updatedAt: new Date() })
          .where(and(eq(notes.id, current.id), eq(notes.userId, userId)))
          .returning();
      }

      await db.insert(revisions).values({
        noteId: row.id,
        userId,
        version: row.version,
        action: "save",
        ...enc,
        updatedBy: input.by,
      });
      return { ok: true as const, note: toFull(dek, row) };
    });
  } catch (e) {
    // Two creates of the same path at once: the partial unique index stops the second.
    if (pgErrorCode(e) === "23505") {
      return { ok: false, code: "version_conflict", error: noteConflictMessage(1), currentVersion: 1 };
    }
    throw e;
  }
}

/** Retire a note at its current version. It leaves the index; its history stays. */
export async function retireNote(
  userId: string,
  dek: Buffer,
  input: { id?: number; path?: string; expectedVersion: number; by: NoteAuthor },
): Promise<NoteWriteResult> {
  if (input.id == null && !input.path) {
    return { ok: false, code: "invalid", error: "Say which note to retire (its id or path)." };
  }
  return withDbTransaction(async () => {
    const where =
      input.id != null
        ? and(eq(notes.userId, userId), eq(notes.id, input.id), isNull(notes.retiredAt))
        : and(eq(notes.userId, userId), eq(notes.pathLookup, pathLookup(dek, input.path!)), isNull(notes.retiredAt));
    const [current] = await db.select().from(notes).where(where).for("update");
    if (!current) return { ok: false as const, code: "not_found" as const, error: "No such note." };
    if (current.version !== input.expectedVersion) {
      return {
        ok: false as const,
        code: "version_conflict" as const,
        error: noteConflictMessage(current.version),
        currentVersion: current.version,
      };
    }
    const [row] = await db
      .update(notes)
      .set({ retiredAt: new Date(), updatedBy: input.by, updatedAt: new Date() })
      .where(and(eq(notes.id, current.id), eq(notes.userId, userId)))
      .returning();
    await db.insert(revisions).values({
      noteId: row.id,
      userId,
      version: row.version,
      action: "retire",
      pathCt: row.pathCt,
      titleCt: row.titleCt,
      summaryCt: row.summaryCt,
      bodyCt: row.bodyCt,
      updatedBy: input.by,
    });
    return { ok: true as const, note: toFull(dek, row) };
  });
}

// ── Backup (FINLYNQ-219 follow-up, 2026-11-17) ─────────────────────────────

/** One note as it travels in a backup file: plain text, so the file restores into any account. */
export interface BackupNote {
  path: string;
  title: string;
  summary: string | null;
  body: string;
  updatedBy: NoteAuthor;
}

/** Active notes for the backup file, decrypted. Notes this key can't read are left out. */
export async function exportNotes(userId: string, dek: Buffer): Promise<BackupNote[]> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), isNull(notes.retiredAt)))
    .orderBy(asc(notes.id));
  return rows
    .map((r) => toFull(dek, r))
    .filter((n) => !n.unreadable)
    .map((n) => ({ path: n.path, title: n.title, summary: n.summary, body: n.body, updatedBy: n.updatedBy }));
}

/**
 * Replace the user's notes with a backup's (restore). Runs inside the caller's
 * transaction (withDbTransaction joins it). Every note is checked with the same
 * rules as a save; the first bad one stops the restore so nothing changes.
 * History restarts: each note comes back as version 1.
 */
export async function replaceNotesFromBackup(
  userId: string,
  dek: Buffer,
  rows: unknown[],
): Promise<{ ok: true; restored: number } | { ok: false; error: string }> {
  if (rows.length > NOTE_MAX_ACTIVE) {
    return { ok: false, error: `The backup has ${rows.length} AI guidance notes; at most ${NOTE_MAX_ACTIVE} are allowed` };
  }
  const cleaned: Array<{ note: ReturnType<typeof checkNote> & { ok: true }; by: NoteAuthor }> = [];
  const seen = new Set<string>();
  for (const [i, raw] of rows.entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const checked = checkNote({
      path: typeof r.path === "string" ? r.path : "",
      title: typeof r.title === "string" ? r.title : "",
      summary: typeof r.summary === "string" ? r.summary : null,
      body: typeof r.body === "string" ? r.body : "",
    });
    if (!checked.ok) return { ok: false, error: `AI guidance note ${i + 1} in the backup can't be restored: ${checked.error}` };
    if (seen.has(checked.note.path)) return { ok: false, error: `The backup has two AI guidance notes called ${checked.note.path}` };
    seen.add(checked.note.path);
    cleaned.push({ note: checked, by: r.updatedBy === "assistant" ? "assistant" : "user" });
  }

  return withDbTransaction(async () => {
    await db.delete(revisions).where(eq(revisions.userId, userId));
    await db.delete(notes).where(eq(notes.userId, userId));
    for (const { note: { note: n }, by } of cleaned) {
      const enc = {
        pathCt: encryptField(dek, n.path)!,
        titleCt: encryptField(dek, n.title)!,
        summaryCt: n.summary == null ? null : encryptField(dek, n.summary),
        bodyCt: encryptField(dek, n.body)!,
      };
      const [row] = await db
        .insert(notes)
        .values({ userId, pathLookup: pathLookup(dek, n.path), ...enc, version: 1, updatedBy: by })
        .returning({ id: notes.id });
      await db.insert(revisions).values({ noteId: row.id, userId, version: 1, action: "save", ...enc, updatedBy: by });
    }
    return { ok: true as const, restored: cleaned.length };
  });
}
