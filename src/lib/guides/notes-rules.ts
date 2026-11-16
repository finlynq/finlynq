/**
 * Rules for a user's guidance notes (FINLYNQ-219). Pure and client-safe, so
 * the Settings form checks exactly what the server checks.
 *
 * A note is a short Markdown file an assistant reads at the start of a
 * session: facts about this user's money that would otherwise be rediscovered
 * every time (a bank whose CSV has its signs reversed, a payee that always
 * means one category). Notes are information, never permission.
 */

import { estimateTokens } from "./registry";

export const NOTE_MAX_TOKENS = 3000;
export const NOTE_MAX_BYTES = 12_000;
export const NOTE_MAX_ACTIVE = 100;
export const NOTE_PATH_MAX = 120;
export const NOTE_TITLE_MAX = 120;
export const NOTE_SUMMARY_MAX = 200;

export type NoteAuthor = "user" | "assistant";

/** Lowercase segments of letters, digits, `-` or `_`, separated by `/`, ending in `.md`. */
const PATH_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.md$/;

export interface NoteDraft {
  path: string;
  title: string;
  summary?: string | null;
  body: string;
}

export interface CleanNote {
  path: string;
  title: string;
  summary: string | null;
  body: string;
}

/** Normalise a path the way a person would type it: trim, lowercase, add `.md`. */
export function normalizeNotePath(raw: string): string {
  let p = raw.trim().toLowerCase().replace(/\\/g, "/").replace(/^\/+/, "");
  if (p && !p.endsWith(".md")) p += ".md";
  return p;
}

export function notePathError(path: string): string | null {
  if (!path) return "Give the note a file name, for example banks/rbc-chequing.md.";
  if (path.length > NOTE_PATH_MAX) return `The file name is too long (at most ${NOTE_PATH_MAX} characters).`;
  if (!PATH_RE.test(path)) {
    return "Use lowercase letters, digits, - and _, with / between folders, ending in .md (for example banks/rbc-chequing.md).";
  }
  return null;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Validate and tidy a note. Returns the cleaned note or the first problem. */
export function checkNote(draft: NoteDraft): { ok: true; note: CleanNote } | { ok: false; error: string } {
  const path = normalizeNotePath(draft.path ?? "");
  const pathError = notePathError(path);
  if (pathError) return { ok: false, error: pathError };

  const title = (draft.title ?? "").trim();
  if (!title) return { ok: false, error: "Give the note a title." };
  if (title.length > NOTE_TITLE_MAX) return { ok: false, error: `The title is too long (at most ${NOTE_TITLE_MAX} characters).` };

  const summaryRaw = (draft.summary ?? "").trim();
  if (summaryRaw.length > NOTE_SUMMARY_MAX) {
    return { ok: false, error: `The summary is too long (at most ${NOTE_SUMMARY_MAX} characters).` };
  }

  const body = (draft.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, error: "The note is empty." };
  if (utf8Bytes(body) > NOTE_MAX_BYTES || estimateTokens(body) > NOTE_MAX_TOKENS) {
    return {
      ok: false,
      error: `The note is too long (about ${estimateTokens(body)} of ${NOTE_MAX_TOKENS} tokens). Split it into two notes.`,
    };
  }

  return { ok: true, note: { path, title, summary: summaryRaw || null, body } };
}

/** The message both surfaces give when someone saved the note in between. */
export function noteConflictMessage(currentVersion: number): string {
  return currentVersion === 0
    ? "This note no longer exists (it was retired or never saved). Start a new note instead."
    : `This note was changed since you opened it (it is now version ${currentVersion}). Reload it and make your change again.`;
}
