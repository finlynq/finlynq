import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Allowed origins for managed (hosted) mode.
 * In self-hosted mode, CORS is not needed (same-origin).
 *
 * Each entry MUST be a full origin (scheme + host + optional port).
 * Wildcards or path components are rejected at module load.
 */
const RAW_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Validate every entry of ALLOWED_ORIGINS at module load. The check rejects
 * `*`, paths, missing schemes, etc. — Cross-Origin-Resource-Sharing wildcards
 * + cookie-auth would be a confused-deputy bug. Throw at boot rather than
 * silently allow a misconfigured production deploy.
 */
function validateAllowedOrigins(entries: string[]): string[] {
  const httpsOriginRe = /^https:\/\/[^\s/]+$/;
  const localhostRe = /^http:\/\/localhost(:\d+)?$/;
  const loopbackRe = /^http:\/\/127\.0\.0\.1(:\d+)?$/;
  for (const entry of entries) {
    if (
      entry === "*" ||
      entry === "null" ||
      !(
        httpsOriginRe.test(entry) ||
        localhostRe.test(entry) ||
        loopbackRe.test(entry)
      )
    ) {
      throw new Error(
        `[middleware] Invalid ALLOWED_ORIGINS entry: ${JSON.stringify(
          entry
        )}. Each entry must be a full origin like "https://app.finlynq.com" or "http://localhost:3000". Wildcards and paths are not allowed.`
      );
    }
  }
  return entries;
}

const MANAGED_ALLOWED_ORIGINS = validateAllowedOrigins(RAW_ALLOWED_ORIGINS);

function getCorsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin");

  // If no allowed origins configured (self-hosted), skip CORS
  if (MANAGED_ALLOWED_ORIGINS.length === 0) {
    return {};
  }

  // Check if the origin is allowed
  if (origin && MANAGED_ALLOWED_ORIGINS.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    };
  }

  return {};
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_COOKIE = "pf_session";

/**
 * Origin/Referer CSRF check for state-changing requests that authenticate via
 * the `pf_session` cookie.
 *
 * Bearer-authenticated requests (Authorization header) carry their own bound
 * credential and are not vulnerable to confused-deputy CSRF — those are
 * skipped here so MCP HTTP, OAuth, and API-key clients keep working.
 *
 * The allowlist is the request's own origin (as derived from
 * `request.nextUrl.origin`) plus anything explicitly listed in
 * `ALLOWED_ORIGINS`. This means same-site requests always succeed and
 * cross-origin POSTs from a phishing page are rejected before any handler
 * runs.
 *
 * Returns null when the request passes the gate, or a 403 NextResponse when
 * it should be blocked.
 */
function csrfCheck(request: NextRequest): NextResponse | null {
  if (!STATE_CHANGING_METHODS.has(request.method)) return null;

  // Bearer / API-key flows authenticate per-request via a bound credential
  // that a foreign origin can't read or replay via cookie-CSRF. Skip them.
  // Mirrors the strategy selection in `selectStrategy()` in
  // `src/lib/auth/require-auth.ts`.
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  if (request.headers.get("x-api-key")) return null;
  try {
    const urlToken = request.nextUrl.searchParams.get("token");
    if (urlToken && urlToken.startsWith("pf_")) return null;
  } catch {
    /* ignore — fall through to cookie check */
  }

  // Only enforce on requests that are actually riding the session cookie.
  // Pre-login routes (POST /api/auth/login) etc. don't carry a cookie yet —
  // letting them through avoids breaking the login flow itself.
  const sessionCookie = request.cookies.get(AUTH_COOKIE);
  if (!sessionCookie) return null;

  const ownOrigin = request.nextUrl.origin;
  const allowed = new Set<string>([ownOrigin, ...MANAGED_ALLOWED_ORIGINS]);

  const origin = request.headers.get("origin");
  if (origin) {
    if (!allowed.has(origin)) {
      return NextResponse.json(
        { error: "csrf-rejected" },
        { status: 403 }
      );
    }
    return null;
  }

  // No Origin header — fall back to Referer. Browsers send Referer on
  // top-level form-POST navigations under SameSite=Lax. Compare its origin
  // against the allowlist.
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (!allowed.has(refOrigin)) {
        return NextResponse.json(
          { error: "csrf-rejected" },
          { status: 403 }
        );
      }
      return null;
    } catch {
      // Malformed Referer
      return NextResponse.json(
        { error: "csrf-rejected" },
        { status: 403 }
      );
    }
  }

  // Cookie-auth state-changing request with NO Origin and NO Referer header
  // is pathological — modern browsers always send at least one. Block.
  return NextResponse.json(
    { error: "csrf-rejected" },
    { status: 403 }
  );
}

export function middleware(request: NextRequest) {
  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    const corsHeaders = getCorsHeaders(request);
    if (Object.keys(corsHeaders).length > 0) {
      return new NextResponse(null, { status: 204, headers: corsHeaders });
    }
    return new NextResponse(null, { status: 204 });
  }

  // CSRF Origin/Referer gate for cookie-auth'd state-changing requests.
  const csrfBlock = csrfCheck(request);
  if (csrfBlock) return csrfBlock;

  const response = NextResponse.next();

  // CORS headers for managed mode
  const corsHeaders = getCorsHeaders(request);
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

  // GA loads only on public marketing pages (/, /cloud, /self-hosted), so its
  // hosts are added to script-src/img-src/connect-src for those routes only.
  const pathname = request.nextUrl.pathname;
  const isWebsite =
    pathname === "/" ||
    pathname === "/cloud" ||
    pathname === "/self-hosted" ||
    pathname.startsWith("/cloud/") ||
    pathname.startsWith("/self-hosted/");

  // CSP `script-src` policy. Today both marketing AND app routes still need
  // `'unsafe-inline'` because:
  //   - Next.js's RSC streaming injects inline `<script>` tags
  //     (`self.__next_f.push(...)`) on every server-rendered page; without
  //     `'unsafe-inline'` (or a per-request nonce on every one of them) the
  //     app fails to hydrate.
  //   - `next-themes` injects its own inline FOUC-prevention script in the
  //     root layout; it accepts a `nonce` prop but Next.js's RSC inline
  //     scripts also need that same nonce to be threaded everywhere.
  //   - Turbopack's dev runtime injects inline HMR scripts.
  // Removing `'unsafe-inline'` requires the full nonce + `'strict-dynamic'`
  // migration tracked as a follow-up. This PR ships the CSRF Origin gate +
  // `object-src 'none'` + CORS startup validator now; the nonce migration
  // lands in a separate change once the touch points have been audited.
  // Residual risk: an HTML-injection sink in a server-rendered template
  // (e.g. unescaped `displayName` interpolation in an email body that is
  // also rendered as a web page somewhere) could still execute. Email
  // template hardening is tracked under finding M-19.
  const scriptSrc = isWebsite
    ? "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://www.googletagmanager.com"
    : "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com";

  const imgSrc = isWebsite
    ? "img-src 'self' data: blob: https://coin-images.coingecko.com https://assets.coingecko.com https://www.google-analytics.com https://www.googletagmanager.com"
    : "img-src 'self' data: blob: https://coin-images.coingecko.com https://assets.coingecko.com";

  const connectSrc = isWebsite
    ? "connect-src 'self' https://www.google-analytics.com https://*.analytics.google.com https://*.google-analytics.com https://www.googletagmanager.com"
    : "connect-src 'self'";

  // Content Security Policy — restrictive default, allow self and inline styles (for Tailwind)
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      imgSrc,
      "font-src 'self'",
      connectSrc,
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );

  // Prevent clickjacking
  response.headers.set("X-Frame-Options", "DENY");

  // Prevent MIME type sniffing
  response.headers.set("X-Content-Type-Options", "nosniff");

  // Referrer policy
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions policy — disable unnecessary browser features
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );

  return response;
}

export const config = {
  matcher: [
    // Apply to all routes except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
