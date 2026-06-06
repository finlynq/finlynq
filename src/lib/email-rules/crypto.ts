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

import { z } from "zod";
import { encryptField, tryDecryptField, isEncrypted } from "@/lib/crypto/envelope";
import { STRING_FIELDS, type EmailConditionGroup } from "./schema";

export interface EmailRuleCryptoFields {
  name?: string | null;
  matchValue?: string | null;
  /** Optional rule-level payee rename — free-text, encrypted like the others. */
  payeeOverride?: string | null;
  /** 2026-06-17 — multi-condition group; text-field string values encrypted,
   *  numeric amount thresholds left plaintext. Tolerates any legacy/partial
   *  shape (read-boundary narrowing), like rules/crypto.ts. */
  conditions?: EmailConditionGroup | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object";
}

// Permissive read-boundary narrowing for the JSONB array crossing the
// encryption boundary — never throws; a parse miss degrades to [] (the
// per-element isObj guard already passes non-objects through). Mirrors
// rules/crypto.ts asJsonArray.
const JsonArray = z.array(z.unknown());
function asJsonArray(value: unknown): unknown[] {
  const parsed = JsonArray.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Apply a per-string transform over a conditions group's text-field values
 *  (sender/subject/body/payee). Numeric amount value/min/max are untouched
 *  because the guard requires STRING_FIELDS.has(field) AND a string value. */
function mapConditionStrings(
  conditions: EmailConditionGroup,
  fn: (s: string) => string,
): EmailConditionGroup {
  const all = (conditions as { all?: unknown }).all;
  if (!Array.isArray(all)) return conditions;
  return {
    ...conditions,
    all: asJsonArray(all).map((c) => {
      if (
        isObj(c) &&
        typeof c.field === "string" &&
        STRING_FIELDS.has(c.field as never) &&
        typeof c.value === "string" &&
        c.value !== ""
      ) {
        return { ...c, value: fn(c.value) };
      }
      return c;
    }),
  } as EmailConditionGroup;
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
  if (rule.conditions && Array.isArray((rule.conditions as { all?: unknown }).all)) {
    out.conditions = mapConditionStrings(rule.conditions, (s) =>
      isEncrypted(s) ? s : (encryptField(dek, s) ?? s),
    );
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
  if (rule.conditions && Array.isArray((rule.conditions as { all?: unknown }).all)) {
    out.conditions = mapConditionStrings(rule.conditions, (s) => tryDecryptField(dek, s) ?? s);
  }
  return out as T;
}

// NOTE: deliberately NO `emailRuleHasPlaintext` — email rules are NOT in the
// login field-encryption sweep (upgrade-user-fields.ts / user-encrypted-
// registry.ts). They rely on encryption-at-write (the CRUD routes are
// requireEncryption), and backfilled condition values are already v1:. Don't
// "complete the pattern" by wiring a sweep here.
