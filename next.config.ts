import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  serverExternalPackages: ["better-sqlite3", "better-sqlite3-multiple-ciphers"],
};

export default nextConfig;
