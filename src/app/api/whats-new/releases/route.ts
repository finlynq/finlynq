/**
 * GET /api/whats-new/releases — release notes for What's New (GH #471).
 *
 * Self-hosted installs only: nobody posts announcements there, so the page
 * was always empty. On Finlynq's hosted service it answers
 * `{ selfHosted: false }` and the page shows announcements alone.
 *
 *   → { selfHosted: true, running, releases, latest, updateCheck }
 *
 * `running` is the newest entry in the build's RELEASES; `latest` is a newer
 * GitHub release when there is one (null otherwise, or when the check is off
 * with PF_UPDATE_CHECK=false).
 */
import { apiHandler } from "@/lib/api-handler";
import { isSelfHosted } from "@/lib/deployment";
import { RELEASES } from "@/lib/seo/releases";
import { releasesForWhatsNew, runningRelease, updateAvailable } from "@/lib/releases/whats-new";
import { getLatestRelease, updateCheckEnabled } from "@/lib/releases/update-check";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "auth" }, async () => {
  if (!isSelfHosted()) return { selfHosted: false as const };
  const running = runningRelease(RELEASES)?.version ?? null;
  const check = updateCheckEnabled();
  const latest = check ? updateAvailable(running, await getLatestRelease()) : null;
  return {
    selfHosted: true as const,
    running,
    releases: releasesForWhatsNew(RELEASES),
    latest,
    updateCheck: check ? ("on" as const) : ("off" as const),
  };
});
