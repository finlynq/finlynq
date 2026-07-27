/**
 * POST /api/prompts/[id]/answer — record a user's answer to a decision prompt
 * (FINLYNQ-301).
 *
 *   body: { version: number, answer: unknown }
 *   → 200 { success:true, data:{ answered:true } }
 *   → 400 when `answer` fails the def's answerSchema, or `version` is stale
 *   → 404 when `id` is not in the registry
 *
 * The def's `persist()` and the ack upsert run inside ONE transaction, so a
 * failed write never records an answer (tc-2). `answer` is validated with the
 * prompt's own schema BEFORE the transaction opens, so a schema-invalid body
 * writes no ack row.
 */

import { z } from "zod";
import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { db, schema } from "@/db";
import { getPromptDef, type PromptDb } from "@/lib/prompts/registry";
import { promptIdFromRequest } from "../../_route-id";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  version: z.number().int(),
  answer: z.unknown(),
});

export const POST = apiHandler(
  { auth: "auth", body: bodySchema },
  async ({ request, userId, body }) => {
    const id = promptIdFromRequest(request as NextRequest);
    const def = getPromptDef(id);
    if (!def) return apiError(`Unknown prompt '${id}'.`, 404);

    if (body.version !== def.version) {
      return apiError("Prompt version is stale — refetch pending prompts.", 400);
    }

    const parsed = def.answerSchema.safeParse(body.answer);
    if (!parsed.success) {
      return apiError("Invalid answer for this prompt.", 400);
    }
    const answer = parsed.data;

    // persist() + ack upsert atomically — a failed write records no answer.
    await db.transaction(async (tx) => {
      await def.persist({ db: tx as PromptDb, userId }, answer);
      await tx
        .insert(schema.userPromptAcks)
        .values({
          userId,
          promptId: def.id,
          version: def.version,
          status: "answered",
          answer: JSON.stringify(answer),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.userPromptAcks.userId,
            schema.userPromptAcks.promptId,
            schema.userPromptAcks.version,
          ],
          set: {
            status: "answered",
            answer: JSON.stringify(answer),
            updatedAt: new Date(),
          },
        });
    });

    return { answered: true };
  },
);
