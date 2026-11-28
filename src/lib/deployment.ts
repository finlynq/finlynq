/**
 * Is this server Finlynq's own hosted service (finlynq.com, dev.finlynq.com)
 * or a self-hosted install? SERVER ONLY (reads process.env).
 *
 * Hosted = `PF_CLOUD` set to 1/true/yes, or `APP_URL` on finlynq.com or one of
 * its subdomains. `PF_CLOUD=0/false/no` forces self-hosted. Everything else
 * (Docker, a home server, localhost) is self-hosted. For UI that only makes
 * sense on one side, never to gate a feature's correctness (GH #471: What's
 * New shows release notes only on self-hosted installs, where nobody posts
 * announcements).
 */
export function isFinlynqCloud(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env.PF_CLOUD ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  if (flag === "0" || flag === "false" || flag === "no") return false;
  try {
    const host = new URL(env.APP_URL ?? "").hostname.toLowerCase();
    return host === "finlynq.com" || host.endsWith(".finlynq.com");
  } catch {
    return false;
  }
}

export function isSelfHosted(env: Record<string, string | undefined> = process.env): boolean {
  return !isFinlynqCloud(env);
}
