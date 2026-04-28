/* eslint-disable no-console */
/**
 * One-shot migration: hash any plaintext API keys sitting in `settings.value`
 * (key='api_key') in place. Idempotent — rows already prefixed with `sha256:`
 * are skipped.
 *
 * Runs outside Next.js so no env-loader surprises:
 *
 *   PGPASSWORD=... npx tsx scripts/migrate-hash-api-keys.ts \
 *     "postgres://finlynq_prod@127.0.0.1/pf"
 *
 * Or with the usual env var:
 *
 *   DATABASE_URL="postgres://..." npx tsx scripts/migrate-hash-api-keys.ts
 *
 * The app's validateApiKey() also migrates rows on access (hash-fallback to
 * raw, then rewrite). This script just sweeps dormant keys so no plaintext
 * is left at rest after the rollout.
 */

import { Pool } from "pg";
import crypto from "crypto";

const HASH_PREFIX = "sha256:";

function hashApiKey(raw: string): string {
  return HASH_PREFIX + crypto.createHash("sha256").update(raw).digest("hex");
}

async function main() {
  const connectionString = process.argv[2] ?? process.env.DATABASE_URL ?? process.env.PF_DATABASE_URL;
  if (!connectionString) {
    console.error("Missing DATABASE_URL (arg or env).");
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    const { rows } = await pool.query<{ user_id: string; value: string }>(
      `SELECT user_id, value FROM settings WHERE key = 'api_key'`
    );

    let hashed = 0;
    let skipped = 0;

    for (const row of rows) {
      if (row.value.startsWith(HASH_PREFIX)) {
        skipped++;
        continue;
      }
      const newValue = hashApiKey(row.value);
      await pool.query(
        `UPDATE settings SET value = $1 WHERE key = 'api_key' AND user_id = $2`,
        [newValue, row.user_id]
      );
      hashed++;
    }

    console.log(`Done. Hashed ${hashed} key(s); ${skipped} already hashed.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
