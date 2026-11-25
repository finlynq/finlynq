/**
 * /api/forecast/snapshots — frozen forecasts to compare with later (plan section 8a).
 *   GET  → { snapshots: SnapshotSummary[] }   (no results)
 *   POST { name, scenarioId?, result, config } → { snapshot }
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { createSnapshot, listSnapshots } from "@/lib/forecast/store";
import { forecastStoreFailure } from "../_response";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async ({ userId, dek }) => ({
  snapshots: await listSnapshots(userId, dek),
  locked: !dek,
}));

const createSchema = z.object({
  name: z.string(),
  scenarioId: z.number().int().positive().nullable().optional(),
  result: z.unknown(),
  config: z.unknown(),
});

export const POST = apiHandler({ auth: "encryption", body: createSchema }, async ({ userId, dek, body }) => {
  const r = await createSnapshot(userId, dek!, body);
  if (!r.ok) return forecastStoreFailure(r);
  return { snapshot: r.snapshot };
});
