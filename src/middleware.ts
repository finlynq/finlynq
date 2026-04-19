import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Allowed origins for managed (hosted) mode.
 * In self-hosted mode, CORS is not needed (same-origin).
 */
const MANAGED_ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ?? ""
).split(",").filter(Boolean);

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

export function middleware(request: NextRequest) {
  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    const corsHeaders = getCorsHeaders(request);
    if (Object.keys(corsHeaders).length > 0) {
      return new NextResponse(null, { status: 204, headers: corsHeaders });
    }
    return new NextResponse(null, { status: 204 });
  }

  const response = NextResponse.next();

  // CORS headers for managed mode
  const corsHeaders = getCorsHeaders(request);
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

  // Content Security Policy — restrictive default, allow self and inline styles (for Tailwind)
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://coin-images.coingecko.com https://assets.coingecko.com",
      "font-src 'self'",
      "connect-src 'self'",
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
