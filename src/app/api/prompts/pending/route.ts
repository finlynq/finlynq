/**
 * GET /api/prompts/pending — the user's currently-pending decision prompts, in
 * registry order (FINLYNQ-301). `[]` when nothing is pending. Consumed by the
 * client `<PromptGate />`; a failure there renders nothing (never blocks the
 * app), so this route stays a plain read.
 */

import { apiHandler } from "@/lib/api-handler";
import { db } from "@/db";
import { getPendingPrompts } from "@/lib/prompts/resolve";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ userId }) => {
  const prompts = await getPendingPrompts(db, userId);
  return { prompts };
});
