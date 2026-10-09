import { describe, it, expect } from "vitest";
import { putDEK, getDEK, deleteDEK, evictAllForUser, clearAllDEKs } from "@/lib/crypto/dek-cache";

describe("dek-cache promotion (pending MFA jti -> session jti)", () => {
  it("a shared Buffer survives deleteDEK of the other entry", () => {
    clearAllDEKs();
    const dek = Buffer.alloc(32, 7);
    putDEK("pending-1", dek, 60_000, "u1");
    putDEK("session-1", dek, 60_000, "u1");
    deleteDEK("pending-1");
    expect(getDEK("session-1", "u1")?.every((b) => b === 7)).toBe(true);
  });
  it("deleting the last holder still zero-fills the buffer", () => {
    clearAllDEKs();
    const dek = Buffer.alloc(32, 9);
    putDEK("s2", dek, 60_000, "u1");
    deleteDEK("s2");
    expect(dek.every((b) => b === 0)).toBe(true);
  });
  it("overwriting an entry with the same buffer does not zero it", () => {
    clearAllDEKs();
    const dek = Buffer.alloc(32, 5);
    putDEK("s3", dek, 60_000, "u1");
    putDEK("s3", dek, 60_000, "u1");
    expect(getDEK("s3", "u1")?.every((b) => b === 5)).toBe(true);
  });
  it("pending buffer is zeroed after promotion with a real copy", () => {
    clearAllDEKs();
    const originalDek = Buffer.alloc(32, 42);
    putDEK("pending-1", originalDek, 60_000, "u1");
    const sessionDek = Buffer.from(originalDek);
    putDEK("session-1", sessionDek, 60_000, "u1");
    deleteDEK("pending-1");
    // originalDek should be zeroed by deleteDEK
    expect(originalDek.every((b) => b === 0)).toBe(true);
    // but session should still be intact
    expect(getDEK("session-1", "u1")?.every((b) => b === 42)).toBe(true);
  });
  it("evictAllForUser zeros all buffers for that user", () => {
    clearAllDEKs();
    const dek1 = Buffer.alloc(32, 11);
    const dek2 = Buffer.alloc(32, 22);
    putDEK("session-1", dek1, 60_000, "u1");
    putDEK("session-2", dek2, 60_000, "u1");
    evictAllForUser("u1");
    expect(dek1.every((b) => b === 0)).toBe(true);
    expect(dek2.every((b) => b === 0)).toBe(true);
  });
  it("evictAllForUser with shared buffer zeros it", () => {
    clearAllDEKs();
    const sharedDek = Buffer.alloc(32, 33);
    putDEK("session-1", sharedDek, 60_000, "u1");
    putDEK("session-2", sharedDek, 60_000, "u1");
    evictAllForUser("u1");
    // Even though both held the same buffer, it should be zeroed when the last one is dropped
    expect(sharedDek.every((b) => b === 0)).toBe(true);
  });
  it("clearAllDEKs zeros all buffers", () => {
    clearAllDEKs();
    const dek1 = Buffer.alloc(32, 44);
    const dek2 = Buffer.alloc(32, 55);
    putDEK("session-1", dek1, 60_000, "u1");
    putDEK("session-2", dek2, 60_000, "u2");
    clearAllDEKs();
    expect(dek1.every((b) => b === 0)).toBe(true);
    expect(dek2.every((b) => b === 0)).toBe(true);
  });
  it("clearAllDEKs with shared buffer zeros it", () => {
    clearAllDEKs();
    const sharedDek = Buffer.alloc(32, 66);
    putDEK("session-1", sharedDek, 60_000, "u1");
    putDEK("session-2", sharedDek, 60_000, "u2");
    clearAllDEKs();
    expect(sharedDek.every((b) => b === 0)).toBe(true);
  });
});
