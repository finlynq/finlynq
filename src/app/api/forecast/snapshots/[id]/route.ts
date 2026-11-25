/**
 * /api/forecast/snapshots/[id]
 *   GET    → { snapshot }   (with the frozen `result` and the `config` that made it)
 *   DELETE → { deleted: true }
 */
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { deleteSnapshot, getSnapshot } from "@/lib/forecast/store";
import { forecastStoreFailure, idFromPath } from "../../_response";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ request, userId, dek }) => {
  const id = idFromPath(request.nextUrl.pathname, "snapshots");
  if (id == null) return apiError("Unknown snapshot.", 404);
  const snapshot = await getSnapshot(userId, dek, id);
  if (!snapshot) return apiError("No such snapshot.", 404);
  return { snapshot };
});

export const DELETE = apiHandler({ auth: "auth" }, async ({ request, userId }) => {
  const id = idFromPath(request.nextUrl.pathname, "snapshots");
  if (id == null) return apiError("Unknown snapshot.", 404);
  const r = await deleteSnapshot(userId, id);
  if (!r.ok) return forecastStoreFailure(r);
  return { deleted: true };
});
