/**
 * Regression test for M-8 (security/B9): backup-export now writes `null`
 * + bumps a `decryptFailures` counter when an envelope's auth-tag check
 * fails, instead of falling back to the raw ciphertext via `?? v`.
 */
import { describe, it, expect } from "vitest";
import { encryptField, generateDEK } from "@/lib/crypto/envelope";
import { decryptRowFields } from "@/app/api/data/export/route";

describe("export decryptRowFields decrypt-failure tracking (M-8)", () => {
  it("returns plaintext + 0 failures when DEK matches", () => {
    const dek = generateDEK();
    const ctPayee = encryptField(dek, "Coffee shop");
    const failures = { count: 0 };
    const out = decryptRowFields(dek, { id: 1, payee: ctPayee }, ["payee"], failures);
    expect(out.payee).toBe("Coffee shop");
    expect(failures.count).toBe(0);
  });

  it("writes null + bumps counter when auth-tag fails (different DEK)", () => {
    const writerDek = generateDEK();
    const readerDek = generateDEK(); // different — auth tag will fail
    const ct = encryptField(writerDek, "Secret note");
    const failures = { count: 0 };
    const out = decryptRowFields(readerDek, { id: 1, note: ct }, ["note"], failures);
    expect(out.note).toBeNull();
    expect(failures.count).toBe(1);
  });

  it("does not embed raw v1: ciphertext on failure (CLAUDE.md invariant)", () => {
    const writerDek = generateDEK();
    const readerDek = generateDEK();
    const ct = encryptField(writerDek, "tag-1,tag-2");
    const failures = { count: 0 };
    const out = decryptRowFields(readerDek, { tags: ct }, ["tags"], failures);
    // The previous `?? v` fallback would have returned the raw v1: string.
    expect(typeof out.tags === "string" && (out.tags as string).startsWith("v1:")).toBe(false);
    expect(out.tags).toBeNull();
  });

  it("counts each failed field separately across multiple rows", () => {
    const writerDek = generateDEK();
    const readerDek = generateDEK();
    const ct1 = encryptField(writerDek, "a");
    const ct2 = encryptField(writerDek, "b");
    const ct3 = encryptField(writerDek, "c");
    const failures = { count: 0 };
    decryptRowFields(readerDek, { payee: ct1, note: ct2 }, ["payee", "note"], failures);
    decryptRowFields(readerDek, { tags: ct3 }, ["tags"], failures);
    expect(failures.count).toBe(3);
  });

  it("passes plaintext (non-v1) values through untouched", () => {
    const dek = generateDEK();
    const failures = { count: 0 };
    const out = decryptRowFields(dek, { payee: "plain text legacy" }, ["payee"], failures);
    expect(out.payee).toBe("plain text legacy");
    expect(failures.count).toBe(0);
  });

  it("returns row unchanged when DEK is null", () => {
    const failures = { count: 0 };
    const row = { payee: "v1:foo:bar:baz" };
    const out = decryptRowFields(null, row, ["payee"], failures);
    expect(out).toBe(row);
    expect(failures.count).toBe(0);
  });
});
