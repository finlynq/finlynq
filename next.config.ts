import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  serverExternalPackages: ["better-sqlite3", "better-sqlite3-multiple-ciphers", "pg", "pdf-parse", "@napi-rs/canvas"],
  // Standalone output bundles everything needed to run with `node server.js`
  // Required for the multi-stage Docker build.
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // When deployed behind Nginx as the managed instance, the app is served
  // under /app. Set NEXT_BASE_PATH=/app at build time to enable this.
  ...(process.env.NEXT_BASE_PATH ? { basePath: process.env.NEXT_BASE_PATH } : {}),
};

export default nextConfig;
