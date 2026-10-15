/**
 * Sign-vs-category is ADVISORY everywhere (2026-10-15, owner request).
 *
 * A refund in an expense category or a reversal in an income one is real
 * money. The validator (`sign-category-invariant.ts`) never threw, but six
 * callers turned its result into a refusal: the email Record click and the
 * email auto-record sweep, the To-approve and To-categorize buttons, the
 * auto-mode rules pass (which left such rows stuck in "To categorize" on every
 * sync), /api/reconcile/materialize, and the staged-rows rules pass. They now
 * book the row and pass the message on as `warning`.
 *
 * A static gate: each site must still CALL the validator (the
 * transactions-INSERT audit invariant keys on it) but must never turn its
 * result into a refusal code, a skip reason, or a 400.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const BOOKING_SITES = [
  "src/lib/email-import/process-pending-inbox.ts",
  "src/app/api/bank-transactions/[bankId]/approve/route.ts",
  "src/app/api/bank-transactions/[bankId]/categorize/route.ts",
  "src/lib/reconcile/match-engine.ts",
  "src/lib/reconcile/materialize-transaction.ts",
];

describe("sign-vs-category never refuses a booking", () => {
  for (const file of BOOKING_SITES) {
    it(`${file} checks the sign but books anyway`, () => {
      const code = codeOnly(read(file));
      expect(code).toContain("validateSignVsCategoryById(");
      expect(code).not.toMatch(/(code|reason|skipReason):\s*"sign_category_mismatch"/);
      expect(code).toContain("warning");
    });
  }

  it("the staged-rows rules pass writes the rule's category whatever the sign", () => {
    const code = codeOnly(read("src/lib/rules/apply-to-staged-batch.ts"));
    expect(code).not.toContain("validateSignVsCategoryById");
    expect(code).toContain("update.category = encode(plainName, row.encryptionTier)");
  });

  it("the materialize route no longer maps a sign mismatch to a 400", () => {
    expect(codeOnly(read("src/app/api/reconcile/materialize/route.ts"))).not.toContain("sign_category_mismatch");
  });

  it("the inbox tabs show the warning instead of dropping it", () => {
    for (const file of [
      "src/components/inbox/inbox-email-tab.tsx",
      "src/components/inbox/inbox-to-approve-tab.tsx",
      "src/components/inbox/inbox-to-categorize-tab.tsx",
    ]) {
      const code = codeOnly(read(file));
      expect(code, file).toContain("warning");
      expect(code, file).toContain("{notice && (");
    }
  });
});
