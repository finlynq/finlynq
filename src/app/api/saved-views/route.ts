/**
 * /api/saved-views — saved reports and saved Transactions views (GH #427).
 *
 *   GET  ?kind=report|transactions → { views: SavedView[], locked }
 *        (without a key every view comes back `unreadable: true`)
 *   POST { kind, name, config, isDefault? } → { view }
 *        409 `duplicate_name` when the name is taken for that kind.
 *
 * All rules live in src/lib/saved-views/store.ts (shared with MCP
 * `get_saved_views`); config shapes in src/lib/saved-views/config.ts.
 */

import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { createSavedView, listSavedViews } from "@/lib/saved-views/store";
import { SAVED_VIEW_KINDS, isSavedViewKind } from "@/lib/saved-views/config";
import { savedViewWriteFailure } from "./_response";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ request, userId, dek }) => {
  const kindParam = request.nextUrl.searchParams.get("kind");
  if (kindParam != null && !isSavedViewKind(kindParam)) {
    return apiError("kind must be report or transactions", 400);
  }
  const views = await listSavedViews(userId, dek, kindParam ?? undefined);
  return { views, locked: !dek };
});

const createSchema = z.object({
  kind: z.enum(SAVED_VIEW_KINDS),
  name: z.string().max(200),
  config: z.unknown(),
  isDefault: z.boolean().optional(),
});

export const POST = apiHandler({ auth: "encryption", body: createSchema }, async ({ userId, dek, body }) => {
  const result = await createSavedView(userId, dek!, body);
  if (!result.ok) return savedViewWriteFailure(result);
  return { view: result.view };
});
