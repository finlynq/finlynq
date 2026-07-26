/**
 * FINLYNQ-301 — user decision prompts registry (SERVER ONLY).
 *
 * A prompt is a "we need an answer from you" surface: a server-side predicate
 * (`appliesTo`) for "does this user still owe me an answer", a small form
 * (registered SEPARATELY in the client `prompt-forms.tsx` id→form map), and a
 * typed writer (`persist`). Per-(user, prompt, version) completion lives in the
 * `user_prompt_acks` table.
 *
 * ⚠️ SERVER ONLY. This module (and everything else under `src/lib/prompts/`
 * except pure types) reaches `db`. NEVER import it into a client component —
 * that drags `pg`/`dns` into the browser bundle (the `accounts/groups-server.ts`
 * failure mode). The client id→form map is `src/components/prompts/prompt-forms.tsx`.
 *
 * How to add a prompt: docs/user-prompts.md.
 */

import type { z } from "zod";
import type { DrizzleDb } from "@/db";

/**
 * A db handle usable by predicates + writers. Accepts both the global `db` (for
 * read-only predicate evaluation) and a transaction client `tx` (so a prompt's
 * `persist` can run atomically with the ack upsert in the answer route).
 */
type TxClient = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];
export type PromptDb = DrizzleDb | TxClient;

export interface PromptContext {
  db: PromptDb;
  userId: string;
}

export interface PromptDef<A = unknown> {
  /** Stable key == `user_prompt_acks.prompt_id`. */
  id: string;
  /** Bump to re-ask everyone (prior answer preserved as its own version row). */
  version: number;
  /** Dialog heading. */
  title: string;
  /** Why we're asking, 1-2 sentences. */
  body: string;
  /** `false` ⇒ no "Not now" escape (the defer route 409s). */
  deferrable: boolean;
  /** `null` = ask forever; otherwise stop re-surfacing after N defers. */
  maxDefers: number | null;
  /** Suppression window after a defer (≈ next login, not next page load). */
  deferCooldownHours: number;
  /** True ⇒ this user still owes an answer for this prompt's subject. */
  appliesTo(ctx: PromptContext): Promise<boolean>;
  /** Validates the client-submitted answer. */
  answerSchema: z.ZodType<A>;
  /** Persist the accepted answer to its real destination. Must be idempotent. */
  persist(ctx: PromptContext, answer: A): Promise<void>;
}

/**
 * The active prompt registry, in surface order. A prompt ships in the same
 * commit as the change that needs it (Phase 4 registers `displayCurrencyPrompt`).
 */
export const PROMPTS: PromptDef[] = [];

/** Look a prompt up by its stable id. */
export function getPromptDef(id: string): PromptDef | undefined {
  return PROMPTS.find((p) => p.id === id);
}
