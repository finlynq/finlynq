import type { NextConfig } from "next";

// Security headers applied to every route. CSP was shipped as Report-Only in
// `50a1742` (2026-04-22) for a watch window; flipped to enforced on
// 2026-04-23 after a clean week. Next.js hydration + Tailwind/shadcn still
// need `'unsafe-inline'` / `'unsafe-eval'` — once we wire nonces through the
// custom document we can drop both.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // Next.js needs inline + eval for its hydration runtime and dev HMR. Once
  // we wire nonces through the custom document we can tighten this.
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
