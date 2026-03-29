import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  serverExternalPackages: ["better-sqlite3", "better-sqlite3-multiple-ciphers", "pg"],
  // Standalone output bundles everything needed to run with `node server.js`
  // Required for the multi-stage Docker build.
  output: "standalone",
};

export default nextConfig;
