import { scryptSync, randomBytes } from "crypto";

const KEY_LENGTH = 32; // 256 bits for AES-256
const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8; // block size
const SCRYPT_P = 1; // parallelism

export function deriveKey(passphrase: string, salt: Buffer): string {
  const key = scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return key.toString("hex");
}

export function generateSalt(): Buffer {
  return randomBytes(16);
}
