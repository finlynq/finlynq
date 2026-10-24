import { describe, it, expect } from "vitest";
import { redactTxCiphertext } from "@/lib/crypto/encrypted-columns";

describe("redactTxCiphertext (locked-session read responses)", () => {
  it("blanks encrypted payee/note/tags, keeps plaintext and other fields", () => {
    const rows = [
      { id: 1, amount: -70000, payee: "v1:abc:def:ghi", note: "v1:x:y:z", tags: "groceries" },
      { id: 2, amount: 5, payee: "Legacy Shop", note: null, tags: undefined },
    ];
    const out = redactTxCiphertext(rows);
    expect(out[0]).toEqual({ id: 1, amount: -70000, payee: null, note: null, tags: "groceries" });
    expect(out[1]).toBe(rows[1]); // untouched rows are passed through as-is
    expect(rows[0].payee).toBe("v1:abc:def:ghi"); // input is not mutated
  });
});
