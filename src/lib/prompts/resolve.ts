/**
 * FINLYNQ-301 — pending-prompt resolution (SERVER ONLY).
 *
 * `getPendingPrompts` evaluates every registry predicate against a user, then
 * filters by their `user_prompt_acks` row. A prompt is PENDING when
 * `appliesTo()` is true AND its ack row is either absent, or `status='deferred'`
 * with a cooled-down `deferred_until` and `defer_count` still under `maxDefers`.
 * `answered` and `dismissed` are terminal for that (prompt, version).
 */

import { and, eq } from "drizzle-orm";
import { schema } from "@/db";
import { PROMPTS, type PromptDb, type PromptDef } from "./registry";

export interface PendingPrompt {
  id: string;
  version: number;
  title: string;
  body: string;
  deferrable: boolean;
  deferCount: number;
}

/** Shape of the ack row fields the pending decision reads. */
export interface AckRow {
  status: string;
  deferCount: number;
  deferredUntil: Date | null;
}

/**
 * PURE decision: given a prompt def and its ack row (or null when absent), is
 * the prompt still pending as of `now`?
 *
 * - absent            → pending
 * - answered/dismissed → terminal (not pending)
 * - deferred          → pending only if cooldown elapsed AND under maxDefers
 */
export function isAckPending(
  def: Pick<PromptDef, "maxDefers">,
  ack: AckRow | null,
  now: Date,
): boolean {
  if (!ack) return true;
  if (ack.status === "answered" || ack.status === "dismissed") return false;
  if (ack.status === "deferred") {
    const cold =
      ack.deferredUntil == null || ack.deferredUntil.getTime() < now.getTime();
    const underMax = def.maxDefers == null || ack.deferCount < def.maxDefers;
    return cold && underMax;
  }
  return false;
}

/** Load the ack row for a (user, prompt, version), or null when absent. */
async function loadAck(
  db: PromptDb,
  userId: string,
  promptId: string,
  version: number,
): Promise<AckRow | null> {
  const rows = await db
    .select({
      status: schema.userPromptAcks.status,
      deferCount: schema.userPromptAcks.deferCount,
      deferredUntil: schema.userPromptAcks.deferredUntil,
    })
    .from(schema.userPromptAcks)
    .where(
      and(
        eq(schema.userPromptAcks.userId, userId),
        eq(schema.userPromptAcks.promptId, promptId),
        eq(schema.userPromptAcks.version, version),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Evaluate every registered prompt for a user and return those still pending,
 * in registry order. Returns `[]` for an empty registry.
 */
export async function getPendingPrompts(
  db: PromptDb,
  userId: string,
): Promise<PendingPrompt[]> {
  const now = new Date();
  const out: PendingPrompt[] = [];
  for (const def of PROMPTS) {
    if (!(await def.appliesTo({ db, userId }))) continue;
    const ack = await loadAck(db, userId, def.id, def.version);
    if (!isAckPending(def, ack, now)) continue;
    out.push({
      id: def.id,
      version: def.version,
      title: def.title,
      body: def.body,
      deferrable: def.deferrable,
      deferCount: ack?.deferCount ?? 0,
    });
  }
  return out;
}
