/**
 * Finlynq guide modules (FINLYNQ-219): short Markdown guides that teach an AI
 * assistant (and the user, on Settings → AI guidance) how to work in one area
 * of the app. They are the GENERAL half of the guidance library; the user's
 * own notes are the personal half (see notes-rules.ts / notes-store.ts).
 *
 * Pure and client-safe: no database, no Node APIs.
 */

export interface GuideModule {
  /** Stable id, lowercase letters/digits/hyphens. Also the finlynq_help topic. */
  id: string;
  title: string;
  /** One line, shown in the index an assistant reads first. */
  summary: string;
  /** Sort order in the index (lower first). */
  order: number;
  markdown: string;
}
