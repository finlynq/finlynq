/**
 * File-envelope encryption for user-uploaded MCP files.
 *
 * Storage format on disk: `v1\0` marker byte || iv (12) || tag (16) || ciphertext
 * The leading `v1\0` magic lets readers detect encrypted vs legacy-plaintext
 * files during transition — after the rollout, any non-magic file is a bug.
 *
 * The DEK used here is the user's session DEK (same one wrapping transaction
 * payees/notes). We never persist the raw file content — Finding #7.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

const MAGIC = Buffer.from("v1\0", "utf8"); // 3 bytes
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export function encryptFileBytes(dek: Buffer, plaintext: Buffer): Buffer {
  if (dek.length !== KEY_LEN) throw new Error("DEK must be 32 bytes");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ct]);
}

/** Returns true if the buffer carries our encryption magic prefix. */
export function isEncryptedFile(buf: Buffer): boolean {
  if (buf.length < MAGIC.length) return false;
  return buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function decryptFileBytes(dek: Buffer, wrapped: Buffer): Buffer {
  if (!isEncryptedFile(wrapped)) {
    // Caller's decision whether this is OK — some transition flows will
    // accept plaintext as-is. We throw so the default posture is "fail loud".
    throw new Error("File is not encrypted (missing v1 magic prefix)");
  }
  if (dek.length !== KEY_LEN) throw new Error("DEK must be 32 bytes");
  const iv = wrapped.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = wrapped.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ct = wrapped.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Decrypt if encrypted, passthrough if not. Returns plaintext bytes. */
export function maybeDecryptFileBytes(dek: Buffer | null, buf: Buffer): Buffer {
  if (!isEncryptedFile(buf)) return buf;
  if (!dek) {
    throw new Error(
      "File is encrypted but no DEK is available. Stdio MCP without a " +
        "user session cannot read HTTP-uploaded MCP files. Use the MCP " +
        "HTTP transport (OAuth or Bearer pf_ token)."
    );
  }
  return decryptFileBytes(dek, buf);
}
