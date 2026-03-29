import { scryptSync, randomBytes } from "crypto";

const KEY_LENGTH = 32; // 256 bits for AES-256
const SCRYPT_N = 65536; // CPU/memory cost (2^16) — production-grade
const SCRYPT_R = 8; // block size
const SCRYPT_P = 1; // parallelism
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2; // ensure enough memory for N=65536

export function deriveKey(passphrase: string, salt: Buffer): string {
  const key = scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const hex = key.toString("hex");
  // Zero the raw key buffer after extracting hex
  key.fill(0);
  return hex;
}

export function generateSalt(): Buffer {
  return randomBytes(32);
}
