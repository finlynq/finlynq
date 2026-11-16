/**
 * /api/guidance/notes — the user's guidance notes (FINLYNQ-219), for
 * Settings → AI guidance.
 *
 *   GET  → { notes: NoteSummary[] | null, locked }   (null + locked when the
 *          session has no key: notes are encrypted)
 *   POST { path, title, summary?, body, expectedVersion } → the saved note.
 *          expectedVersion 0 creates; otherwise it must be the current version
 *          (409 `version_conflict` with `currentVersion` when someone, e.g. the
 *          assistant, saved in between).
 *
 * All rules live in src/lib/guides/notes-store.ts, shared with MCP
 * `get_guidance` / `manage_guidance_notes`.
 */

import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { listNotes, saveNote } from "@/lib/guides/notes-store";
import { noteWriteFailure } from "./_response";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ userId, dek }) => {
  if (!dek) return { notes: null, locked: true };
  return { notes: await listNotes(userId, dek), locked: false };
});

const saveSchema = z.object({
  path: z.string().max(200),
  title: z.string().max(200),
  summary: z.string().max(400).nullable().optional(),
  body: z.string().max(20000),
  expectedVersion: z.number().int().min(0),
});

export const POST = apiHandler({ auth: "encryption", body: saveSchema }, async ({ userId, dek, body }) => {
  const result = await saveNote(userId, dek!, { ...body, by: "user" });
  if (!result.ok) return noteWriteFailure(result);
  return { note: result.note };
});
