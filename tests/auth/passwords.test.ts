import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";

describe("Password hashing", () => {
  it("hashes a password to a bcrypt string", async () => {
    const hash = await hashPassword("my-password-123");
    expect(hash).toMatch(/^\$2[aby]\$/);
    expect(hash.length).toBeGreaterThan(50);
  });

  it("produces different hashes for the same password (salted)", async () => {
    const h1 = await hashPassword("same-password");
    const h2 = await hashPassword("same-password");
    expect(h1).not.toBe(h2);
  });

  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct-horse-battery");
    const valid = await verifyPassword("correct-horse-battery", hash);
    expect(valid).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery");
    const valid = await verifyPassword("wrong-password", hash);
    expect(valid).toBe(false);
  });
});
