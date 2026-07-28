/**
 * Seed the scratch TEST account (`demo2`) — the throwaway user behind
 * `/try-demo2`.
 *
 * Deliberately the opposite of scripts/seed-demo.ts: that one builds a
 * showcase-ready account full of fixture data, this one creates an EMPTY user
 * with `onboarding_complete = 0`, so the first visit lands in the onboarding
 * wizard exactly as a real signup does. It exists so testing first-run flows
 * (the wizard, empty states, "Clear All Data") never requires minting a new
 * account by hand.
 *
 * Idempotent. Re-running only refreshes the identity row (password hash + DEK
 * wrap) and flips `onboarding_complete` back to 0 — it does NOT delete data.
 * To wipe the account's data, use the app's own "Clear All Data" button on
 * /settings/data, which runs the audited `clearAllUserData` path AND resets the
 * onboarding flag; this script exists to create the user, not to duplicate that
 * delete list.
 *
 * Usage:
 *   PF_ALLOW_DEMO_SEED=1 DATABASE_URL="postgresql://..." npx tsx scripts/seed-demo2.ts
 *
 * ⚠️ The credentials are published in src/app/try-demo2/route.ts and this repo
 * is public — the account is world-readable and world-writable by design. Never
 * point this at a database where that is not acceptable.
 */

import pg from "pg";
import { createHash } from "crypto";
import bcrypt from "bcryptjs";
import { rewrapDEKForNewPassword } from "../src/lib/crypto/envelope";

const EMAIL = "demo2@finlynq.com";
const USERNAME = "demo2";
const PASSWORD = "finlynq-demo2";
// Mirrors the demo's canonical-UUID convention (…-00000000demo). The final
// group must be exactly 12 chars or anything that casts this to `uuid` breaks.
const USER_ID = "00000000-0000-0000-0000-0000000demo2";
const DISPLAY_NAME = "Finlynq Test";

/**
 * Pinned DEK, same rationale as the demo account's (FINLYNQ-281): a re-seed
 * must not re-encrypt rows under a fresh key while a live session still caches
 * the old one. Safe ONLY because this account's data is disposable and its
 * password is public — NEVER pin a real user's DEK.
 */
const DEK = createHash("sha256")
  .update("finlynq-demo2-scratch-account-fixed-dek-v1")
  .digest();

const databaseUrl: string = (() => {
  const url = process.env.DATABASE_URL ?? process.env.PF_DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL or PF_DATABASE_URL must be set.");
    process.exit(1);
  }
  return url;
})();

// Same opt-in gate the demo seed uses — creating a public-credential account is
// never something a deploy should do implicitly.
if (process.env.PF_ALLOW_DEMO_SEED !== "1") {
  console.error(
    "ERROR: refusing to seed the scratch test account without PF_ALLOW_DEMO_SEED=1.",
  );
  process.exit(1);
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log(`[seed-demo2] Target DB: ${databaseUrl.split("@")[1] ?? "(hidden)"}`);
    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(PASSWORD, 12);
    const wrap = rewrapDEKForNewPassword(DEK, PASSWORD);

    // ON CONFLICT (id) so a re-seed refreshes the identity in place. The wrap
    // (salt/iv/tag) is regenerated each run but still unwraps to the same DEK.
    // `onboarding_complete` is reset to 0 on every run — that IS the point of
    // re-seeding: put the account back in first-run state.
    await client.query(
      `INSERT INTO users (id, username, email, password_hash, display_name, role, email_verified, mfa_enabled, onboarding_complete, plan, kek_salt, dek_wrapped, dek_wrapped_iv, dek_wrapped_tag, encryption_v, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'user', 1, 0, 0, 'free', $6, $7, $8, $9, 1, $10, $10)
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username,
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         display_name = EXCLUDED.display_name,
         onboarding_complete = 0,
         kek_salt = EXCLUDED.kek_salt,
         dek_wrapped = EXCLUDED.dek_wrapped,
         dek_wrapped_iv = EXCLUDED.dek_wrapped_iv,
         dek_wrapped_tag = EXCLUDED.dek_wrapped_tag,
         encryption_v = EXCLUDED.encryption_v,
         updated_at = EXCLUDED.updated_at`,
      [
        USER_ID,
        USERNAME,
        EMAIL,
        passwordHash,
        DISPLAY_NAME,
        wrap.salt.toString("base64"),
        wrap.wrapped.toString("base64"),
        wrap.iv.toString("base64"),
        wrap.tag.toString("base64"),
        now,
      ],
    );

    const { rows } = await client.query(
      `SELECT id, onboarding_complete FROM users WHERE id = $1`,
      [USER_ID],
    );
    console.log(
      `[seed-demo2] Ready: ${EMAIL} (id ${rows[0]?.id}, onboarding_complete=${rows[0]?.onboarding_complete}).`,
    );
    console.log(`[seed-demo2] Sign in with one click at /try-demo2`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[seed-demo2] FAILED:", err);
  process.exit(1);
});
