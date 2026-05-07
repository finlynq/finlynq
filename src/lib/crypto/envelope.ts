import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from "crypto";

// scrypt cost: N=2^16, r=8, p=1 → ~64MB memory, ~80ms on modern hardware.
// Raise N if we benchmark faster than 100ms; lower if login becomes noticeable.
const SCRYPT_N = 2 ** 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const IV_LEN = 12; // AES-GCM standard
const TAG_LEN = 16;

const FIELD_VERSION = "v1";

/**
 * Optional server-side pepper mixed into the scrypt password input. When set,
 * a stolen DB alone (with `password_hash` + `kek_salt` + `dek_wrapped`) is
 * insufficient to run an offline crack — the attacker also needs filesystem
 * access to read this value. Required in production; dev falls back to
 * no-pepper with a one-time warning so tests still work.
 *
 * The pepper is not a secret-to-users feature (users can't recover it even
 * if they lose access); it only raises the bar against DB-only leaks.
 *
 * Pepper rotation (Open #2 from SECURITY_HANDOVER_2026-05-07.md):
 * `users.pepper_version` (added by 20260507_pepper_version.sql) names which
 * env var to read. Version 1 → `PF_PEPPER` (legacy, default for every
 * existing row). Version N (>1) → `PF_PEPPER_V<N>`. The rotation flow:
 *
 *   1. Operator sets PF_PEPPER_V2=<new> alongside PF_PEPPER=<old> and
 *      restarts the service. Both peppers are now readable.
 *   2. Operator runs `scripts/rewrap-peppers.ts` — for every row at
 *      pepper_version=1, derive KEK with old pepper, unwrap DEK, re-wrap
 *      with KEK derived from the new pepper, UPDATE the row + set
 *      pepper_version=2. Idempotent and resumable.
 *   3. Once `pepper_version=1` count is zero, the operator can drop
 *      PF_PEPPER from the env (or rename PF_PEPPER_V2 → PF_PEPPER and
 *      bump the migration default in code). Until then, both peppers
 *      MUST stay set so reads from any unrotated row keep working.
 */
const HIGHEST_SUPPORTED_PEPPER_VERSION = 2;

function getPepperForVersion(version: number): Buffer {
  if (version < 1 || version > HIGHEST_SUPPORTED_PEPPER_VERSION) {
    throw new Error(
      `[envelope] pepper_version=${version} is not supported by this build. ` +
        `Highest supported version is ${HIGHEST_SUPPORTED_PEPPER_VERSION}. ` +
        `Did the DB get rotated past what the running code knows about?`
    );
  }
  const envVar = version === 1 ? "PF_PEPPER" : `PF_PEPPER_V${version}`;
  const raw = process.env[envVar];
  if (raw && raw.length >= 32) return Buffer.from(raw, "utf8");
  if (process.env.NODE_ENV === "production") {
    if (!raw) {
      throw new Error(
        `${envVar} env var is required in production (≥32 chars) for ` +
          `pepper_version=${version} rows. ` +
          `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      );
    }
    throw new Error(`${envVar} must be at least 32 characters`);
  }
  // Dev fallback — stable empty buffer so dev DEKs stay readable across
  // restarts. We warn once per version so it's visible but not noisy.
  if (!pepperWarned.has(version)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[envelope] ${envVar} not set — using empty pepper for dev. ` +
        "DO NOT deploy to production without setting it."
    );
    pepperWarned.add(version);
  }
  return Buffer.alloc(0);
}

/**
 * Backwards-compat alias for callers that don't know about pepper versioning
 * yet. Returns the version-1 pepper (the legacy single-pepper behavior).
 * Internal code paths that have a `users.pepper_version` available should
 * call `getPepperForVersion` directly.
 */
function getPepper(): Buffer {
  return getPepperForVersion(1);
}
const pepperWarned = new Set<number>();

/** HMAC the password with the pepper before scrypt. The scrypt input becomes
 * HMAC-SHA256(pepper, password), which is cryptographically equivalent to
 * a password-plus-pepper scheme but avoids worrying about delimiter
 * collisions, pepper-length edge cases, or concatenation ambiguity. An
 * empty pepper (dev fallback) degrades gracefully to plain HMAC(∅, password). */
function pepperedPasswordBytes(password: string, version = 1): Buffer {
  const pepper = getPepperForVersion(version);
  return createHmac("sha256", pepper).update(password, "utf8").digest();
}

export interface WrappedDEK {
  salt: Buffer;
  wrapped: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** Derive a 32-byte KEK from a password + salt via scrypt. Slow by design.
 *
 * Input is `HMAC(PF_PEPPER, password)` — the pepper lives in server env only,
 * not in the DB. A DB-only leak can't compute this input, so offline scrypt
 * cracking is blocked unless the attacker also has filesystem access.
 *
 * `pepperVersion` defaults to 1 (legacy `PF_PEPPER`). During a pepper
 * rotation, callers that have a `users.pepper_version` available should pass
 * it through so the right env var is read. Routes that need the user row
 * already are loading it for password verification — they have it for free.
 */
export function deriveKEK(password: string, salt: Buffer, pepperVersion = 1): Buffer {
  return scryptSync(pepperedPasswordBytes(password, pepperVersion), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Generate a fresh random 32-byte DEK. Called once per account at signup. */
export function generateDEK(): Buffer {
  return randomBytes(KEY_LEN);
}

/**
 * Wrap a DEK with a KEK (AES-256-GCM).
 * Returns {salt, wrapped, iv, tag}. The caller supplies the salt used for KEK derivation.
 */
export function wrapDEK(kek: Buffer, dek: Buffer, salt: Buffer): WrappedDEK {
  if (kek.length !== KEY_LEN) throw new Error("KEK must be 32 bytes");
  if (dek.length !== KEY_LEN) throw new Error("DEK must be 32 bytes");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { salt, wrapped, iv, tag };
}

/** Unwrap a DEK. Throws on auth-tag failure (wrong password). */
export function unwrapDEK(kek: Buffer, w: WrappedDEK): Buffer {
  if (kek.length !== KEY_LEN) throw new Error("KEK must be 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", kek, w.iv);
  decipher.setAuthTag(w.tag);
  const dek = Buffer.concat([decipher.update(w.wrapped), decipher.final()]);
  if (dek.length !== KEY_LEN) throw new Error("DEK unwrap returned wrong size");
  return dek;
}

/** Generate salt for KEK derivation. Store alongside the wrapped DEK. */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LEN);
}

/**
 * One-shot signup: password → (salt, wrapped DEK components, raw DEK for caching).
 * The raw DEK is returned so the caller can cache it for the new session.
 */
export function createWrappedDEKForPassword(password: string): {
  dek: Buffer;
  wrapped: WrappedDEK;
} {
  const salt = generateSalt();
  const kek = deriveKEK(password, salt);
  const dek = generateDEK();
  const wrapped = wrapDEK(kek, dek, salt);
  return { dek, wrapped };
}

/**
 * Re-wrap an existing DEK with a new password (for password change).
 * DEK stays the same — row data is untouched.
 */
export function rewrapDEKForNewPassword(
  dek: Buffer,
  newPassword: string
): WrappedDEK {
  const salt = generateSalt();
  const kek = deriveKEK(newPassword, salt);
  return wrapDEK(kek, dek, salt);
}

// ─── Field-level encryption ──────────────────────────────────────────────────

/**
 * Encrypt a string field with the user's DEK.
 * Output format: `v1:<base64(iv)>:<base64(ciphertext)>:<base64(tag)>`
 * Null/undefined passes through unchanged — we don't encrypt empty values.
 */
export function encryptField(dek: Buffer, plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === "") return plaintext ?? null;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${FIELD_VERSION}:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

/**
 * Decrypt a string field.
 * - If input is null/empty: returns unchanged.
 * - If input doesn't start with `v1:`: treated as legacy plaintext and returned as-is.
 *   (This lets us migrate gradually; pre-encryption rows stay readable until re-written.)
 * - If v1 prefix but decrypt fails: throws.
 */
export function decryptField(dek: Buffer, value: string | null | undefined): string | null {
  if (value == null || value === "") return value ?? null;
  if (!value.startsWith(`${FIELD_VERSION}:`)) return value; // legacy plaintext passthrough
  const parts = value.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted field");
  }
  const iv = Buffer.from(parts[1], "base64");
  const ct = Buffer.from(parts[2], "base64");
  const tag = Buffer.from(parts[3], "base64");
  if (iv.length !== IV_LEN) throw new Error("Invalid IV length");
  if (tag.length !== TAG_LEN) throw new Error("Invalid tag length");
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Decrypt-or-null: same as {@link decryptField} but returns `null` on
 * auth-tag failure instead of throwing. Returning null (rather than the
 * raw v1: ciphertext) keeps the `?? plaintextFallback` pattern at call
 * sites working correctly — otherwise dedup maps and lookups would key
 * on the ciphertext string and miss every legitimate match. Logs a
 * single warn per failure so the underlying mismatch (DEK rotation,
 * wipe-rewrap orphan, genuine corruption) stays visible.
 */
export function tryDecryptField(
  dek: Buffer,
  value: string | null | undefined,
  context?: string,
): string | null {
  try {
    return decryptField(dek, value);
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[envelope] tryDecryptField failed${context ? ` (${context})` : ""}; returning null:`,
        err instanceof Error ? err.message : String(err),
      );
    } catch { /* ignore */ }
    return null;
  }
}

/** Returns true if a stored value looks like a v1 ciphertext. Useful for audits/tests. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${FIELD_VERSION}:`);
}

/**
 * Constant-time buffer comparison for equality checks (e.g. HMAC tags).
 * Exposed for blind-index work in Phase 4.
 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
