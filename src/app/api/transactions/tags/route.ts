/**
 * GET /api/transactions/tags → { tags: { tag, count }[], locked }
 *
 * Every tag on the user's transactions (GH #427: the Reports tag filter).
 * Tags are encrypted, so without a key the list is empty and `locked` true.
 */
import { apiHandler } from "@/lib/api-handler";
import { listUserTags } from "@/lib/transactions/tag-list";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ userId, dek }) => {
  return { tags: await listUserTags(userId, dek), locked: !dek };
});
