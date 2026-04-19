import type { NextConfig } from "next";

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
};

export default nextConfig;
