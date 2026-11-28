/**
 * Account logos on the phone (mirrors the web's GH #420 avatars).
 *
 * Logos are set on the website (Edit account → Details → Get logo / Upload).
 * The phone only shows them: one small request (`GET /api/accounts/logos`)
 * says which accounts have one and at what version, then each logo image is
 * `GET /api/accounts/<id>/logo?v=<version>` with the session's Bearer token.
 * The version changes whenever the logo does, so the image cache never
 * shows an old logo. No logo, a failed request, or a server without the
 * route all mean the screen keeps its usual icon.
 */

import { endpoints, getAuthToken, getServerUrl } from "../api/client";

export type LogoVersions = Record<number, number>;

/** How long one answer is reused across screens (the list and the account page). */
export const LOGO_VERSIONS_TTL_MS = 60_000;

let cache: { at: number; versions: LogoVersions } | null = null;
let inFlight: Promise<LogoVersions> | null = null;

/** Normalize the route's `{ versions: { "12": 1732… } }` into numeric keys, dropping junk. */
export function parseLogoVersions(data: unknown): LogoVersions {
  const raw =
    data && typeof data === "object" && "versions" in data
      ? (data as { versions?: unknown }).versions
      : null;
  const out: LogoVersions = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    if (Number.isInteger(id) && id > 0 && typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[id] = v;
    }
  }
  return out;
}

/** Which accounts have a logo. Never throws; any failure reads as "none". */
export async function loadLogoVersions(force = false, now = Date.now()): Promise<LogoVersions> {
  if (!force && cache && now - cache.at < LOGO_VERSIONS_TTL_MS) return cache.versions;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await endpoints.getAccountLogoVersions();
      const versions = res.success ? parseLogoVersions(res.data) : {};
      // Cache only a real answer: a failure retries on the next screen.
      if (res.success) cache = { at: Date.now(), versions };
      return versions;
    } catch {
      return {};
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Forget the cached answer (sign-out: it belongs to the previous user). */
export function clearLogoVersions() {
  cache = null;
}

/** Image source for one account's logo, or null when it has none. */
export function accountLogoSource(
  accountId: number,
  version: number | undefined,
): { uri: string; headers?: Record<string, string> } | null {
  if (!version) return null;
  const uri = `${getServerUrl()}/api/accounts/${accountId}/logo?v=${version}`;
  const token = getAuthToken();
  return token ? { uri, headers: { Authorization: `Bearer ${token}` } } : { uri };
}
