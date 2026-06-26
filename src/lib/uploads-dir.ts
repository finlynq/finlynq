/**
 * Durable on-disk uploads base directory (FINLYNQ-228).
 *
 * THE DEPLOY-WIPE BUG: on the VPS, pf-dev/pf run from
 * `WorkingDirectory=.next/standalone`, and `deploy.sh` does
 * `mv .next .next.old && rm -rf .next.old` on EVERY deploy. So any path computed
 * as `process.cwd()/uploads` resolves to `.next/standalone/uploads/` — which is
 * INSIDE the `.next` tree and therefore permanently deleted on each redeploy.
 * Feedback attachments (and mcp_uploads) stored there silently vanish.
 *
 * `getUploadsBaseDir()` resolves the uploads root OUTSIDE `.next`:
 *   1. `PF_UPLOADS_DIR` env override (Docker / self-hosted should mount a
 *      persistent volume here) → used verbatim.
 *   2. else, when cwd ends with `/.next/standalone` (the standalone server
 *      layout), climb two levels to the deployment root and use `<root>/uploads`
 *      (a SIBLING of `.next`, so a `.next` wipe never touches it).
 *   3. else `<cwd>/uploads` (local `npm run dev`, tests).
 */

import path from "path";

/** Resolve the durable uploads base directory (absolute path, outside `.next`). */
export function getUploadsBaseDir(): string {
  const override = process.env.PF_UPLOADS_DIR;
  if (override && override.trim()) return override.trim();

  const cwd = process.cwd();
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.endsWith("/.next/standalone")) {
    // <root>/.next/standalone → <root>/uploads (sibling of .next).
    return path.join(cwd, "..", "..", "uploads");
  }
  return path.join(cwd, "uploads");
}
