import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "packages/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "shared/**"],
      reporter: ["text", "text-summary"],
    },
    // Component tests use jsdom via inline config
    environmentMatchGlobs: [
      ["tests/components/**", "jsdom"],
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
