/**
 * Resolve the set of origins that should be treated as "same as us" when
 * deciding whether to allow a state-changing cookie-auth request through
 * the CSRF gate.
 *
 * Behind a reverse proxy, neither `NextRequest.nextUrl.origin` nor
 * `nextUrl.host` is reliable:
 *
 *  1. The Next.js standalone server reads `process.env.HOSTNAME` (typically
 *     `0.0.0.0` when bound to all interfaces) and reflects it in
 *     `nextUrl.host`. So even when the browser sends `Host: dev.example.com`,
 *     `nextUrl.host` returns `0.0.0.0:3000` — useless for origin matching.
 *  2. The protocol the browser saw (https when behind a TLS-terminating
 *     proxy) is not reflected in the internal binding (which is plain http).
 *     Next.js partially compensates by reading `X-Forwarded-Proto` for
 *     `nextUrl.protocol`, but the host bug above defeats that anyway.
 *
 * Fix: derive the public origin from the inbound `Host` header (which the
 * proxy passes through unchanged from the browser) and the scheme from
 * `X-Forwarded-Proto` (set by the proxy) — falling back to `nextUrl.protocol`
 * for self-hosted single-process setups with no proxy.
 *
 * Threat model: CSRF defends against a logged-in browser visiting an
 * attacker page. Browsers always set `Host` to the URL they're hitting
 * and `Origin` to their page's origin — they cannot mismatch the two
 * across a same-origin fetch. An attacker bypassing the proxy and hitting
 * the backend directly is a different (LAN-level) threat that CSRF does
 * not defend against.
 *
 * Defense-in-depth:
 *  - Whitelist `X-Forwarded-Proto` to "http" or "https" exactly.
 *  - Sanitize Host header to `[A-Za-z0-9.-]+(:port)?` only — rejects any
 *    embedded `,` `;` ` ` etc. that would let a misconfigured upstream
 *    inject a bogus origin.
 *  - We deliberately do NOT trust `X-Forwarded-Host` because that one IS
 *    forgeable end-to-end (any forward proxy or misconfigured edge can
 *    inject it).
 */

export interface OriginRequestParts {
  /** What `NextRequest.nextUrl.origin` returns — kept as a fallback for
   *  self-hosted setups that don't go through a proxy. */
  fallbackOrigin: string;
  /** What `NextRequest.nextUrl.protocol` returns — `"http:"` or `"https:"`.
   *  Used to choose a scheme when no `X-Forwarded-Proto` is present. */
  fallbackProtocol: string;
  /** The inbound `Host` header (browser's view; proxy passes it through). */
  hostHeader: string | null;
  /** Header lookup. Case-insensitive in real `Headers`; pass `(name) =>
   *  request.headers.get(name)`. */
  getHeader: (name: string) => string | null;
}

const HOST_RE = /^[A-Za-z0-9.-]+(:\d+)?$/;

/**
 * Returns the set of origins that count as "us" for this request, in
 * canonical `scheme://host[:port]` form. Always includes the URL-derived
 * fallback. Adds a Host-header-derived origin when the Host is well-formed,
 * using `X-Forwarded-Proto` if present, otherwise the fallback protocol.
 */
export function getRequestOrigins(parts: OriginRequestParts): string[] {
  const { fallbackOrigin, fallbackProtocol, hostHeader, getHeader } = parts;
  const origins = new Set<string>([fallbackOrigin]);

  if (hostHeader && HOST_RE.test(hostHeader)) {
    const fwdProto = getHeader("x-forwarded-proto");
    let proto: "http" | "https" | null = null;
    if (fwdProto === "https" || fwdProto === "http") {
      proto = fwdProto;
    } else if (fallbackProtocol === "https:") {
      proto = "https";
    } else if (fallbackProtocol === "http:") {
      proto = "http";
    }
    if (proto) {
      origins.add(`${proto}://${hostHeader}`);
    }
  }

  return Array.from(origins);
}
