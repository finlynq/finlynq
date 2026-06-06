/**
 * Email-import rule conditions (2026-06-17).
 *
 * Widens email rules from a single flat (match_type/match_op/match_value) match
 * to an AND-only group of typed conditions, mirroring the transaction-rules
 * `ConditionGroup` shape (src/lib/rules/schema.ts) trimmed to the email domain.
 *
 * Fields:
 *   - text: sender | subject | body | payee — ops contains/exact/regex, value: string
 *   - amount: numeric — ops gt/lt/between (compared on |amount|; see load.ts)
 *
 * `sender`/`subject` match the email headers; `body` matches the decrypted body
 * (text, or HTML stripped to text); `payee`/`amount` match the parser's extracted
 * candidate. AND-only: a rule matches when ALL its conditions match (no OR in v1).
 *
 * Encryption: only string `value`s for STRING_FIELDS are user-DEK encrypted at
 * rest (see crypto.ts) — numeric amount thresholds stay plaintext + matchable,
 * exactly like transaction-rules leaves currency/amount plaintext.
 */

import { z } from "zod";

const StringOp = z.enum(["contains", "exact", "regex"]);
const AmountOp = z.enum(["gt", "lt"]);

const TextCondition = z.object({
  field: z.enum(["sender", "subject", "body", "payee"]),
  op: StringOp,
  value: z.string().min(1).max(512),
});

const AmountConditionSingle = z.object({
  field: z.literal("amount"),
  op: AmountOp,
  value: z.number(),
});

const AmountConditionBetween = z.object({
  field: z.literal("amount"),
  op: z.literal("between"),
  min: z.number(),
  max: z.number(),
});

// Top-level z.union (NOT discriminatedUnion): the two `field:"amount"` branches
// share a discriminator value, which Zod v4 rejects in discriminatedUnion — the
// same constraint that forced src/lib/rules/schema.ts onto z.union.
export const EmailCondition = z.union([
  TextCondition,
  AmountConditionSingle,
  AmountConditionBetween,
]);
export type EmailCondition = z.infer<typeof EmailCondition>;

export const EmailConditionGroup = z.object({
  all: z.array(EmailCondition).min(1).max(20),
});
export type EmailConditionGroup = z.infer<typeof EmailConditionGroup>;

export type EmailConditionField = EmailCondition["field"];

/** Fields whose `.value` is user free-text → encrypted at rest. `amount` is
 *  numeric (value/min/max) and is deliberately absent so the crypto walker
 *  leaves it plaintext. Single source shared by crypto.ts + the matcher. */
export const STRING_FIELDS = new Set<EmailConditionField>([
  "sender",
  "subject",
  "body",
  "payee",
]);

type TextMember = Extract<EmailCondition, { field: "sender" | "subject" | "body" | "payee" }>;

/** Fully-typed default for a freshly-selected field (the editor swaps the whole
 *  row on field change, like the transaction-rules editor). */
export const EMAIL_CONDITION_DEFAULTS: {
  sender: () => TextMember;
  subject: () => TextMember;
  body: () => TextMember;
  payee: () => TextMember;
  amount: () => Extract<EmailCondition, { field: "amount" }>;
} = {
  sender: () => ({ field: "sender", op: "contains", value: "" }),
  subject: () => ({ field: "subject", op: "contains", value: "" }),
  body: () => ({ field: "body", op: "contains", value: "" }),
  payee: () => ({ field: "payee", op: "contains", value: "" }),
  amount: () => ({ field: "amount", op: "lt", value: 500 }),
};

export function defaultEmailConditionForField(field: EmailConditionField): EmailCondition {
  return EMAIL_CONDITION_DEFAULTS[field]();
}

/** Field options for the editor select. */
export const EMAIL_CONDITION_FIELDS: Array<{ value: EmailConditionField; label: string }> = [
  { value: "sender", label: "Sender" },
  { value: "subject", label: "Subject" },
  { value: "body", label: "Body" },
  { value: "payee", label: "Payee" },
  { value: "amount", label: "Amount" },
];
