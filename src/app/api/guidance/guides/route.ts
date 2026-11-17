/**
 * GET /api/guidance/guides — Finlynq's guide modules (FINLYNQ-219), with their
 * Markdown. The web Settings page imports the registry directly; the phone
 * app reads them here. Same list `finlynq_help` and `get_guidance` serve.
 */

import { apiHandler } from "@/lib/api-handler";
import { GUIDE_MODULES } from "@/lib/guides/registry";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async () => ({
  guides: GUIDE_MODULES.map((m) => ({ id: m.id, title: m.title, summary: m.summary, markdown: m.markdown })),
}));
