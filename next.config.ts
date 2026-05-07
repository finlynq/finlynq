import type { NextConfig } from "next";

// Security headers applied to every route. CSP was shipped as Report-Only in
// `50a1742` (2026-04-22) for a watch window; flipped to enforced on
// 2026-04-23 after a clean week.
//
// NOTE (B10, 2026-05-07): the AUTHORITATIVE CSP is set by middleware on
// every HTML response — it carries a per-request nonce and the `script-src`
// directive built around `'nonce-...' 'strict-dynamic'`. The static CSP
// below is a fallback for the rare case where middleware doesn't run
// (matcher excludes `_next/static` etc., which don't render HTML anyway).
// Keep `'unsafe-inline'` here as a defensive fallback only; middleware will
// overwrite this header in practice.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // Fallback only — middleware overrides with a nonce-based directive on
  // every HTML response. See src/middleware.ts.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com",
  // Tailwind + shadcn emit inline styles at render time — unavoidable.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://assets.coingecko.com https://coin-images.coingecko.com https://www.google-analytics.com https://www.googletagmanager.com",
  "font-src 'self' data:",
  "connect-src 'self' https://query1.finance.yahoo.com https://api.coingecko.com https://www.google-analytics.com https://*.analytics.google.com https://*.google-analytics.com https://www.googletagmanager.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "Content-Security-Policy", value: CSP_DIRECTIVES },
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Standalone output for Docker deployments (produces .next/standalone)
  output: "standalone",
  typescript: {
    // TypeScript errors are checked in CI, skip during production build
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ["pg", "pdf-parse", "@napi-rs/canvas"],
  // Compile .ts workspace packages directly (they ship source, not dist).
  transpilePackages: ["@finlynq/import-connectors"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // When deployed behind Nginx as the managed instance, the app is served
  // under /app. Set NEXT_BASE_PATH=/app at build time to enable this.
  ...(process.env.NEXT_BASE_PATH ? { basePath: process.env.NEXT_BASE_PATH } : {}),
  // /mcp is a vanity shortcut for the MCP server. 308 preserves POST/SSE bodies,
  // so Claude's connector flow (MCP Streamable HTTP + OAuth .well-known discovery)
  // follows the redirect cleanly.
  async redirects() {
    return [
      { source: "/mcp", destination: "/api/mcp", permanent: true },
      { source: "/mcp/:path*", destination: "/api/mcp/:path*", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
