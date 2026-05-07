/* eslint-disable no-console */
/**
 * End-to-end smoke test for the Phase 1 encryption primitives.
 * Runs outside Next.js to validate signup → login → write → read →
 * password change → logout lifecycles.
 *
 *   npx tsx scripts/smoke-encryption.ts
 */

import {
  createWrappedDEKForPassword,
  deriveKEK,
  unwrapDEK,
  decryptField,
  rewrapDEKForNewPassword,
} from "../src/lib/crypto/envelope";
import { putDEK, getDEK, deleteDEK } from "../src/lib/crypto/dek-cache";
import {
  encryptTxWrite,
  decryptTxRow,
  filterDecryptedBySearch,
} from "../src/lib/crypto/encrypted-columns";

function assert(label: string, cond: unknown) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
}

const pw = "correct horse battery staple";
const { dek, wrapped } = createWrappedDEKForPassword(pw);

putDEK("jti-1", dek, 60_000, "user-1");
assert("cache hit after signup", getDEK("jti-1", "user-1")?.equals(dek));

const input = {
  date: "2026-04-20",
  amount: -12.5,
  payee: "Starbucks",
  note: "morning",
  tags: "food,coffee",
  portfolioHolding: null,
};
const encrypted = encryptTxWrite(dek, input);
assert("payee is v1 ciphertext", encrypted.payee?.startsWith("v1:"));
assert("amount stays plaintext", encrypted.amount === -12.5);
assert("date stays plaintext", encrypted.date === "2026-04-20");

const row = {
  id: 1,
  amount: -12.5,
  date: "2026-04-20",
  payee: encrypted.payee,
  note: encrypted.note,
  tags: encrypted.tags,
  portfolioHolding: null as string | null,
};
const decrypted = decryptTxRow(dek, row);
assert("decrypted payee round-trips", decrypted.payee === "Starbucks");
assert("decrypted note round-trips", decrypted.note === "morning");

const hits = filterDecryptedBySearch([decrypted], "starbucks");
assert("search finds match after decryption", hits.length === 1);

const kek2 = deriveKEK(pw, wrapped.salt);
const dek2 = unwrapDEK(kek2, wrapped);
assert("login re-derives same DEK", dek2.equals(dek));

const newWrap = rewrapDEKForNewPassword(dek, "new-password");
const dek3 = unwrapDEK(deriveKEK("new-password", newWrap.salt), newWrap);
assert(
  "old ciphertext decrypts after password change",
  decryptField(dek3, encrypted.payee) === "Starbucks"
);

deleteDEK("jti-1");
assert("cache miss after logout", getDEK("jti-1", "user-1") === null);

console.log("\nAll Phase 1 smoke checks passed.");
