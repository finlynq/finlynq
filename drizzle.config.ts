import { defineConfig } from "drizzle-kit";

// NOTE: drizzle-kit cannot open encrypted databases directly.
// Use `drizzle-kit generate` to generate migration SQL files,
// then apply them with: PF_PASSPHRASE="..." npx tsx scripts/db-push.ts
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "./pf.db",
  },
});
