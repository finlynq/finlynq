import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  typescript: {
    // TypeScript errors are checked in CI, skip during production build
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ["pg", "pdf-parse", "@napi-rs/canvas"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // When deployed behind Nginx as the managed instance, the app is served
  // under /app. Set NEXT_BASE_PATH=/app at build time to enable this.
  ...(process.env.NEXT_BASE_PATH ? { basePath: process.env.NEXT_BASE_PATH } : {}),
};

export default nextConfig;
