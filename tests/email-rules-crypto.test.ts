import { describe, it, expect } from "vitest";
import { encryptEmailRuleFields, decryptEmailRuleFields } from "@/lib/email-rules/crypto";
import { isEncrypted } from "@/lib/crypto/envelope";
import type { EmailConditionGroup } from "@/lib/email-rules/schema";

const DEK = Buffer.alloc(32, 7);

function group(): EmailConditionGroup {
  return {
    all: [
      { field: "sender", op: "contains", value: "alerts@chase.com" },
      { field: "body", op: "regex", value: "charged \\$\\d+" },
      { field: "amount", op: "between", min: 50, max: 100 },
      { field: "payee", op: "exact", value: "STARBUCKS" },
    ],
  };
}

/** Read a condition group's `.all` loosely (the union has no common `.value`). */
function rows(g: EmailConditionGroup | null | undefined): Record<string, unknown>[] {
  return ((g?.all ?? []) as unknown[]) as Record<string, unknown>[];
}

describe("email-rules crypto — conditions", () => {
  it("encrypts text-field string values + leaves numeric amount untouched", () => {
    const enc = encryptEmailRuleFields(DEK, {
      name: "Chase",
      payeeOverride: "Rent",
      conditions: group(),
    });
    const all = rows(enc.conditions);
    expect(isEncrypted(all[0].value as string)).toBe(true); // sender
    expect(isEncrypted(all[1].value as string)).toBe(true); // body
    expect(isEncrypted(all[3].value as string)).toBe(true); // payee
    // amount: numeric bounds byte-identical (never encrypted)
    expect(all[2]).toEqual({ field: "amount", op: "between", min: 50, max: 100 });
    expect(isEncrypted(enc.name as string)).toBe(true);
    expect(isEncrypted(enc.payeeOverride as string)).toBe(true);
  });

  it("round-trips back to the original plaintext on decrypt", () => {
    const enc = encryptEmailRuleFields(DEK, { name: "Chase", payeeOverride: "Rent", conditions: group() });
    const dec = decryptEmailRuleFields(DEK, enc);
    expect(dec.name).toBe("Chase");
    expect(dec.payeeOverride).toBe("Rent");
    const all = rows(dec.conditions);
    expect(all[0].value).toBe("alerts@chase.com");
    expect(all[1].value).toBe("charged \\$\\d+");
    expect(all[3].value).toBe("STARBUCKS");
    expect(all[2]).toEqual({ field: "amount", op: "between", min: 50, max: 100 });
  });

  it("null DEK passes through unchanged", () => {
    const enc = encryptEmailRuleFields(null, { name: "Chase", conditions: group() });
    expect(enc.name).toBe("Chase");
    expect(rows(enc.conditions)[0].value).toBe("alerts@chase.com");
  });

  it("is idempotent — a second encrypt does not double-encrypt", () => {
    const once = encryptEmailRuleFields(DEK, { conditions: group() });
    const twice = encryptEmailRuleFields(DEK, once);
    expect(twice.conditions).toEqual(once.conditions);
  });
});
