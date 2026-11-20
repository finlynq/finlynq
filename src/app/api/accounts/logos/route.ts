/**
 * GET /api/accounts/logos — which accounts have a logo (GH #420).
 *
 *   { success: true, data: { versions: { [accountId]: versionMs } } }
 *
 * DEK-free and tiny: the UI asks once and requests /api/accounts/[id]/logo?v=
 * only for accounts that have one (no 404 noise, and the version busts the
 * browser cache when a logo changes).
 */

import { apiHandler } from "@/lib/api-handler";
import { listLogoVersions } from "@/lib/accounts/logo-store";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth", fallbackMessage: "Failed to load logos" }, async ({ userId }) => {
  return { versions: await listLogoVersions(userId) };
});
