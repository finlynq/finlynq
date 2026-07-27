/**
 * POST /api/prompts/[id]/defer — "Not now": suppress a decision prompt for its
 * cooldown window and bump `defer_count` (FINLYNQ-301).
 *
 *   body: { version: number }
 *   → 200 { success:true, data:{ deferredUntil: string } }
 *   → 400 when `version` is stale
 *   → 404 when `id` is not in the registry
 *   → 409 when the prompt is `deferrable:false`
 *
 * The cooldown (`deferCooldownHours`, ≈ next login) is the cross-device escape:
 * the same suppression applies everywhere the user signs in, no session storage.
 */

import { z } from "zod";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { db, schema } from "@/db";
import { getPromptDef } from "@/lib/prompts/registry";
import { promptIdFromRequest } from "../../_route-id";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ version: z.number().int() });

export const POST = apiHandler(
  { auth: "auth", body: bodySchema },
  async ({ request, userId, body }) => {
    const id = promptIdFromRequest(request as NextRequest);
    const def = getPromptDef(id);
    if (!def) return apiError(`Unknown prompt '${id}'.`, 404);

    if (body.version !== def.version) {
      return apiError("Prompt version is stale — refetch pending prompts.", 400);
    }

    if (!def.deferrable) {
      return apiError("This prompt cannot be deferred.", 409);
    }

    const deferredUntil = new Date(
      Date.now() + def.deferCooldownHours * 60 * 60 * 1000,
    );

    await db
      .insert(schema.userPromptAcks)
      .values({
        userId,
        promptId: def.id,
        version: def.version,
        status: "deferred",
        deferCount: 1,
        deferredUntil,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.userPromptAcks.userId,
          schema.userPromptAcks.promptId,
          schema.userPromptAcks.version,
        ],
        set: {
          status: "deferred",
          deferCount: sql`${schema.userPromptAcks.deferCount} + 1`,
          deferredUntil,
          updatedAt: new Date(),
        },
      });

    return { deferredUntil: deferredUntil.toISOString() };
  },
);
