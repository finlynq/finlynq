import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getRequestOrigins } from "@/lib/request-origins";

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

/**
 * Resolve the origins that count as "us" for this request. Combines the
 * URL-derived fallback with a Host-header + X-Forwarded-Proto-derived
 * origin when the request came in via a reverse proxy. See
 * [src/lib/request-origins.ts] for the full threat-model rationale and
 * why `nextUrl.host` alone is unreliable (it reflects HOSTNAME=0.0.0.0
 * from the systemd unit, not the public hostname). Issue #176.
 */
function getOwnOriginsFor(request: NextRequest): string[] {
  return getRequestOrigins({
    fallbackOrigin: request.nextUrl.origin,
    fallbackProtocol: request.nextUrl.protocol,
    hostHeader: request.headers.get("host"),
    getHeader: (name) => request.headers.get(name),
  });
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

  // Includes both the URL-derived origin AND the proxy-reported origin
  // when behind Caddy/nginx (X-Forwarded-Proto). See issue #176 — without
  // the proxy-derived entry, every same-origin POST 403s because Next.js
  // sees the binding as `http://localhost:<port>` while the browser sends
  // `Origin: https://...`.
  const allowed = new Set<string>([
    ...getOwnOriginsFor(request),
    ...MANAGED_ALLOWED_ORIGINS,
  ]);

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

/**
 * Generate a cryptographically random nonce for per-request CSP.
 * 16 random bytes encoded as base64 — meets the CSP spec's recommendation
 * (≥128 bits of entropy). `crypto.randomUUID` would also work but base64
 * keeps the header shorter.
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Base64-encode without using Buffer (Edge runtime compat).
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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

  // Per-request CSP nonce (B10 / finding C-8). Server components read this
  // via `headers().get('x-nonce')` and pass it to <ThemeProvider> + <Script>
  // so framework-injected and app-injected inline scripts can be tagged.
  // We propagate it BOTH on the inbound request headers (for `headers()`
  // RSC reads) AND in the outbound CSP `script-src` directive.
  const nonce = generateNonce();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

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

  // CSP `script-src` policy — per-request nonce + 'strict-dynamic'
  // (B10 / finding C-8).
  //
  // 'strict-dynamic' propagates trust transitively: a script loaded with a
  // valid nonce can in turn load other scripts (covers Next.js HMR + the GA
  // gtag loader). When 'strict-dynamic' is present, host-source allowlists
  // (e.g. `https://www.googletagmanager.com`) are IGNORED by modern browsers
  // — the nonce'd loader brings the trust with it.
  //
  // 'unsafe-eval' is dev-only — Next.js's HMR / React Refresh runtimes
  // evaluate code via `eval`/`new Function` in dev mode. Production builds
  // do not need it.
  const isDev = process.env.NODE_ENV !== "production";

  const scriptSrcParts = [
    "script-src",
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // Legacy browser fallback. CSP3-compliant browsers ignore these when
    // 'strict-dynamic' is present; older ones (which would otherwise block
    // every script) accept them.
    "https:",
    "http:",
  ];
  if (isDev) {
    scriptSrcParts.push("'unsafe-eval'");
  }
  const scriptSrc = scriptSrcParts.join(" ");

  const imgSrc = isWebsite
    ? "img-src 'self' data: blob: https://coin-images.coingecko.com https://assets.coingecko.com https://www.google-analytics.com https://www.googletagmanager.com"
    : "img-src 'self' data: blob: https://coin-images.coingecko.com https://assets.coingecko.com";

  const connectSrc = isWebsite
    ? "connect-src 'self' https://www.google-analytics.com https://*.analytics.google.com https://*.google-analytics.com https://www.googletagmanager.com"
    : "connect-src 'self'";

  // Content Security Policy — script-src is now nonce-based with
  // 'strict-dynamic'. 'unsafe-inline' has been removed from script-src
  // entirely; 'object-src none' blocks Flash/`<object>`/`<embed>`.
  // style-src still needs 'unsafe-inline' because Tailwind + shadcn emit
  // inline styles at render time — that's a separate hardening (no
  // current finding tracks it; styles can't exfiltrate the way scripts can).
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
      "object-src 'none'",
    ].join("; ")
  );

  // Expose the nonce on the response so route handlers / debugging tools
  // can read it. Server components read it via `headers().get('x-nonce')`
  // (set on the inbound request above).
  response.headers.set("x-nonce", nonce);

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
