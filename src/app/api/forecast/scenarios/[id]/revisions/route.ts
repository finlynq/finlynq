/**
 * /api/forecast/scenarios/[id]/revisions
 *   GET  → { revisions: [{ version, summary, updatedBy, createdAt }] }  (newest first)
 *   POST { toVersion, expectedVersion } → { scenario }   (puts that version back, as a new version)
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { listRevisions, revertScenario } from "@/lib/forecast/store";
import { forecastStoreFailure, idFromPath } from "../../../_response";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ request, userId, dek }) => {
  const id = idFromPath(request.nextUrl.pathname, "scenarios");
  if (id == null) return apiError("Unknown scenario.", 404);
  return { revisions: await listRevisions(userId, dek, id) };
});

const revertSchema = z.object({ toVersion: z.number().int().positive(), expectedVersion: z.number().int().positive() });

export const POST = apiHandler({ auth: "encryption", body: revertSchema }, async ({ request, userId, dek, body }) => {
  const id = idFromPath(request.nextUrl.pathname, "scenarios");
  if (id == null) return apiError("Unknown scenario.", 404);
  const r = await revertScenario(userId, dek!, id, body.toVersion, body.expectedVersion);
  if (!r.ok) return forecastStoreFailure(r);
  return { scenario: r.scenario };
});
