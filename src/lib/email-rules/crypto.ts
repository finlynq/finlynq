/**
 * Email-import-rule field encryption (Epic B2/B5).
 *
 * Rules carry two user free-text fields — `name` and `match_value` (the
 * sender/subject needle). Both are user-DEK encrypted at rest so a DB-only
 * leak can't read "sender contains chase.com → Chequing". The match_type /
 * match_op / FK ids / mode stay plaintext so the matcher + FK guards keep
 * working after a decrypt. Mirrors src/lib/rules/crypto.ts (transaction rules),
 * trimmed to the two flat columns.
 *
 * Encrypt at write (CRUD route, always has a session DEK), decrypt at
 * read/match (the sweep + the rules list).
 */

import { encryptField, tryDecryptField, isEncrypted } from "@/lib/crypto/envelope";

export interface EmailRuleCryptoFields {
  name?: string | null;
  matchValue?: string | null;
  /** Optional rule-level payee rename — free-text, encrypted like the others. */
  payeeOverride?: string | null;
}

/** Encrypt the two sensitive fields for storage. Null DEK / already-`v1:`
 *  values pass through untouched (no double-encrypt). */
export function encryptEmailRuleFields<T extends EmailRuleCryptoFields>(
  dek: Buffer | null,
  rule: T,
): T {
  if (!dek) return rule;
  const out: EmailRuleCryptoFields = { ...rule };
  if (typeof rule.name === "string" && rule.name !== "" && !isEncrypted(rule.name)) {
    out.name = encryptField(dek, rule.name) ?? rule.name;
  }
  if (
    typeof rule.matchValue === "string" &&
    rule.matchValue !== "" &&
    !isEncrypted(rule.matchValue)
  ) {
    out.matchValue = encryptField(dek, rule.matchValue) ?? rule.matchValue;
  }
  if (
    typeof rule.payeeOverride === "string" &&
    rule.payeeOverride !== "" &&
    !isEncrypted(rule.payeeOverride)
  ) {
    out.payeeOverride = encryptField(dek, rule.payeeOverride) ?? rule.payeeOverride;
  }
  return out as T;
}

/** Decrypt the two sensitive fields for display/matching. Tolerates legacy
 *  plaintext (passthrough) and a null DEK (returns the rule unchanged); on
 *  auth-tag failure returns the raw ciphertext (`?? s`) rather than throwing. */
export function decryptEmailRuleFields<T extends EmailRuleCryptoFields>(
  dek: Buffer | null,
  rule: T,
): T {
  if (!dek) return rule;
  const out: EmailRuleCryptoFields = { ...rule };
  if (typeof rule.name === "string" && rule.name !== "") {
    out.name = tryDecryptField(dek, rule.name) ?? rule.name;
  }
  if (typeof rule.matchValue === "string" && rule.matchValue !== "") {
    out.matchValue = tryDecryptField(dek, rule.matchValue) ?? rule.matchValue;
  }
  if (typeof rule.payeeOverride === "string" && rule.payeeOverride !== "") {
    out.payeeOverride = tryDecryptField(dek, rule.payeeOverride) ?? rule.payeeOverride;
  }
  return out as T;
}
