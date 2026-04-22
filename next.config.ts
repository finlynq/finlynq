import type { NextConfig } from "next";

// Security headers applied to every route. CSP is shipped as Report-Only on
// first deploy so we can watch the browser console for a week before flipping
// to enforced — Next.js hydration + Tailwind/shadcn produce inline styles and
// inline scripts that are hard to fully enumerate up front. To enforce, change
// the header name below from `Content-Security-Policy-Report-Only` to
// `Content-Security-Policy` once the console is clean.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // Next.js needs inline + eval for its hydration runtime and dev HMR. Once
  // we wire nonces through the custom document we can tighten this.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  // Tailwind + shadcn emit inline styles at render time — unavoidable.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://assets.coingecko.com https://coin-images.coingecko.com",
  "font-src 'self' data:",
  "connect-src 'self' https://query1.finance.yahoo.com https://api.coingecko.com",
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
  // Report-Only for the first week — flip to `Content-Security-Policy` after
  // verifying the browser console is quiet on prod.
  { key: "Content-Security-Policy-Report-Only", value: CSP_DIRECTIVES },
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
