import { defineConfig } from "drizzle-kit";

// PostgreSQL drizzle-kit config for managed hosted product.
// Usage: npx drizzle-kit generate --config=drizzle-pg.config.ts
export default defineConfig({
  schema: "./src/db/schema-pg.ts",
  out: "./drizzle-pg",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://localhost:5432/pf",
  },
});
