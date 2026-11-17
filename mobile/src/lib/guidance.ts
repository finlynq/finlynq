// AI guidance on the phone (FINLYNQ-219): Finlynq's guides plus the user's own
// notes, which an AI assistant connected to Finlynq reads before it starts.
// Pure, so the screens only render what these return.
//
// The note rules are a MIRROR of the web's src/lib/guides/notes-rules.ts and
// the wording follows the web's Settings → AI guidance page: keep them in sync.
// The server checks everything again; this only lets the form say so first.

export interface GuideModule {
  id: string;
  title: string;
  summary: string;
  markdown: string;
}

export type NoteAuthor = "user" | "assistant";

export interface NoteSummary {
  id: number;
  path: string;
  title: string;
  summary: string | null;
  version: number;
  updatedBy: NoteAuthor;
  updatedAt: string;
  /** Saved under a key this session doesn't have, so it can't be shown. */
  unreadable?: boolean;
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

export const GUIDANCE_INTRO =
  "What an AI assistant connected to Finlynq reads before it starts: Finlynq's own guides, and notes about your money that you or your assistant saved.";
export const NOTES_HINT =
  "Notes are facts that save your assistant work, like a bank whose file has its signs reversed or a payee that always means one category. They are information, not permission: your assistant still asks before acting. Never put passwords, keys or account numbers in a note.";
export const GUIDES_HINT =
  "Finlynq's guides for each area. Your assistant reads them when a task needs them. They come with the app and can't be edited here.";
export const NOTES_EMPTY = "No notes yet. Your assistant can add them as it learns, or you can write one.";
export const NOTES_LOCKED = "Your notes are encrypted and this session is locked. Sign in again to see and edit them.";
export const NOTES_LOAD_ERROR = "Couldn't load your notes.";
export const GUIDES_LOAD_ERROR = "Couldn't load the guides.";
export const NOTE_LOAD_ERROR = "Couldn't open that note.";
export const NOTE_SAVE_ERROR = "Couldn't save the note.";
export const NOTE_RETIRE_ERROR = "Couldn't retire the note.";
export const NETWORK_ERROR = "Couldn't reach Finlynq. Your text is still here; try again.";
export const UNREADABLE = "Can't be read in this session";
export const UNREADABLE_DETAIL =
  "It was saved with an encryption key this session doesn't have, so it can't be shown or edited here. You can retire it.";
export const RETIRE_TITLE = "Retire this note?";
export const RETIRE_BODY = "Your assistant will stop reading it. Its history is kept.";

export const NOTE_MAX_TOKENS = 3000;
export const NOTE_MAX_BYTES = 12_000;
export const NOTE_PATH_MAX = 120;
export const NOTE_TITLE_MAX = 120;
export const NOTE_SUMMARY_MAX = 200;

const PATH_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.md$/;

/** Same model-independent estimate the server uses: about 4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

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

/** "you" or "your assistant", as the web page says it. */
export function authorLabel(by: NoteAuthor): string {
  return by === "assistant" ? "your assistant" : "you";
}

/** "Changed by your assistant, Nov 16, 2026" — the date built by hand, not Intl. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function changedLine(n: Pick<NoteSummary, "updatedBy" | "updatedAt" | "version">): string {
  return `Version ${n.version} · changed by ${authorLabel(n.updatedBy)}, ${shortDate(n.updatedAt)}`;
}

export function revisionLine(r: NoteRevision): string {
  return `Version ${r.version} · ${r.action === "retire" ? "retired" : "saved"} by ${authorLabel(r.updatedBy)}, ${shortDate(r.createdAt)}`;
}

/** The save error to show: a 423 means the session is locked, otherwise the server's own words. */
export function saveErrorText(error: string | undefined, fallback = NOTE_SAVE_ERROR): string {
  if (!error) return fallback;
  if (error === "session_locked" || /HTTP 423/.test(error)) return NOTES_LOCKED;
  if (/^HTTP \d+$/.test(error)) return fallback;
  if (/^Network error/.test(error)) return NETWORK_ERROR;
  return error;
}
