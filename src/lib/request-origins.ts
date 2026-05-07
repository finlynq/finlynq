/**
 * Resolve the set of origins that should be treated as "same as us" when
 * deciding whether to allow a state-changing cookie-auth request through
 * the CSRF gate.
 *
 * Behind a reverse proxy (Caddy / nginx / Cloudflare) the Next.js process
 * binds on `http://localhost:<port>` while the public URL is on `https`.
 * `NextRequest.nextUrl.origin` is reconstructed from the inbound URL and
 * does not consult `X-Forwarded-Proto`, so it returns `http://...` even
 * though the browser sees `https://...`. The browser sends the public
 * `Origin: https://...` and the membership check fails — every same-origin
 * cookie POST 403s, including legitimate ones (issue #176).
 *
 * Fix: include the proxy-reported origin (built from `X-Forwarded-Proto`
 * + the inbound `Host`) alongside the URL-derived origin in the allow
 * list. Self-hosted users on a single-process binding (no proxy, no
 * `X-Forwarded-Proto` header) keep the previous behavior with no env
 * var to set.
 *
 * Threat model: CSRF is a browser-side concern. A browser cannot spoof
 * `X-Forwarded-Proto` — that header is set by the trusted reverse proxy.
 * An attacker bypassing the proxy and hitting the backend directly is a
 * different threat and is not what the CSRF gate defends against. Even
 * so, we whitelist the protocol value to "http" / "https" and reuse the
 * URL-derived host (NOT `X-Forwarded-Host`, which IS spoofable end-to-
 * end), so a malicious header from inside the LAN cannot construct
 * arbitrary origins.
 */

export interface OriginRequestParts {
  /** What `NextRequest.nextUrl.origin` would return — scheme://host[:port] */
  fallbackOrigin: string;
  /** What `NextRequest.nextUrl.host` would return — host[:port] (no scheme) */
  fallbackHost: string;
  /** Header lookup. Case-insensitive in real `Headers`; we lowercase here too. */
  getHeader: (name: string) => string | null;
}

/**
 * Returns the set of origins that count as "us" for this request, in
 * canonical `scheme://host[:port]` form. Always includes the URL-derived
 * fallback. May add a proxy-derived origin if `X-Forwarded-Proto` is
 * present and differs from the fallback's scheme.
 */
export function getRequestOrigins(parts: OriginRequestParts): string[] {
  const { fallbackOrigin, fallbackHost, getHeader } = parts;
  const origins = new Set<string>([fallbackOrigin]);

  const fwdProto = getHeader("x-forwarded-proto");
  if (fwdProto === "https" || fwdProto === "http") {
    // Use the existing host (browser's Host header — same as what
    // nextUrl.host already reflects). We deliberately do NOT trust
    // X-Forwarded-Host; an upstream proxy hop or a misconfigured edge
    // could inject an arbitrary host there.
    if (fallbackHost) {
      origins.add(`${fwdProto}://${fallbackHost}`);
    }
  }

  return Array.from(origins);
}
