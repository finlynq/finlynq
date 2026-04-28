/**
 * Service-key envelope for transient staged data (Finding #9).
 *
 * Rows in `staged_transactions` sit for up to 14 days before a user approves
 * or rejects them. The inbound webhook has no access to the user's DEK
 * (Resend signatures are server-wide, not per-user), so we can't wrap with
 * the user's DEK at receive time. Instead, wrap with a server-side service
 * key.
 *
 * Threat model: this protects against a DB-dump-only attacker (who doesn't
 * have the env var). It does NOT protect against a server admin (who has
 * env + DB + process). That's the same boundary as the password-envelope
 * pepper — encryption at rest, not at runtime.
 *
 * If `PF_STAGING_KEY` is unset in dev, staged rows fall back to plaintext
 * with a one-time warning. Production requires the key.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "crypto";

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const MARKER = "sv1:";

let stagingWarned = false;

function getServiceKey(): Buffer | null {
  const raw = process.env.PF_STAGING_KEY;
  if (raw && raw.length >= 32) {
    // Normalise any length-≥32 input to a 32-byte key via SHA-256. Lets ops
    // use hex, base64, or a human-readable passphrase interchangeably.
    return createHash("sha256").update(raw, "utf8").digest();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PF_STAGING_KEY env var is required in production (≥32 chars). " +
        "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  if (!stagingWarned) {
    // eslint-disable-next-line no-console
    console.warn(
      "[staging-envelope] PF_STAGING_KEY not set — staged imports will store plaintext. " +
        "DO NOT deploy to production without setting it."
    );
    stagingWarned = true;
  }
  return null;
}

/** Encrypt a plaintext string with the service key. Returns `sv1:<b64>` or
 * the original string if the service key is unset (dev fallback). */
export function encryptStaged(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  const key = getServiceKey();
  if (!key) return plaintext; // dev fallback
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MARKER + Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a staged value. Passes plaintext through if missing the marker
 * (legacy rows from before the rollout). */
export function decryptStaged(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!value.startsWith(MARKER)) return value; // legacy plaintext
  const key = getServiceKey();
  if (!key) {
    throw new Error("Cannot decrypt staged row: PF_STAGING_KEY missing");
  }
  const buf = Buffer.from(value.slice(MARKER.length), "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("Malformed staged ciphertext");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// Suppress unused-var lint for KEY_LEN in environments where it's constant-only.
void KEY_LEN;
