import {
  scryptSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
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

export interface WrappedDEK {
  salt: Buffer;
  wrapped: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** Derive a 32-byte KEK from a password + salt via scrypt. Slow by design. */
export function deriveKEK(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, {
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
