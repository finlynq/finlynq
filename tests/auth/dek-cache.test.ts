/**
 * Tests for the in-memory DEK cache after the B7 hardening:
 *  - userId scoping (defense-in-depth against jti collision)
 *  - buffer zeroing on eviction
 *  - evictAllForUser
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  putDEK,
  getDEK,
  deleteDEK,
  evictAllForUser,
  clearAllDEKs,
} from "@/lib/crypto/dek-cache";

const TTL_MS = 60_000;

describe("DEK cache — userId scoping (B7)", () => {
  beforeEach(() => {
    clearAllDEKs();
  });

  it("getDEK with the wrong userId returns null", () => {
    const dek = Buffer.alloc(32, 0xab);
    putDEK("jti-abc", dek, TTL_MS, "user-correct");
    expect(getDEK("jti-abc", "user-correct")).not.toBeNull();
    expect(getDEK("jti-abc", "user-wrong")).toBeNull();
  });

  it("getDEK with the correct userId returns the buffer", () => {
    const dek = Buffer.alloc(32, 0xcd);
    putDEK("jti-xyz", dek, TTL_MS, "user-xyz");
    const out = getDEK("jti-xyz", "user-xyz");
    expect(out).not.toBeNull();
    expect(out!.equals(dek)).toBe(true);
  });

  it("missing entry returns null on any userId", () => {
    expect(getDEK("nonexistent", "user-any")).toBeNull();
  });
});

describe("DEK cache — buffer zeroing (B7 / M-7)", () => {
  beforeEach(() => {
    clearAllDEKs();
  });

  it("deleteDEK zeroes the buffer before eviction", () => {
    const dek = Buffer.alloc(32, 0xff);
    expect(dek[0]).toBe(0xff);
    putDEK("jti-zero-1", dek, TTL_MS, "user-z");
    deleteDEK("jti-zero-1");
    // The buffer reference we held should have been overwritten in place.
    for (let i = 0; i < dek.length; i++) {
      expect(dek[i]).toBe(0);
    }
  });

  it("clearAllDEKs zeroes every cached buffer", () => {
    const a = Buffer.alloc(32, 0x11);
    const b = Buffer.alloc(32, 0x22);
    putDEK("j-a", a, TTL_MS, "u-a");
    putDEK("j-b", b, TTL_MS, "u-b");
    clearAllDEKs();
    expect(a.every((byte) => byte === 0)).toBe(true);
    expect(b.every((byte) => byte === 0)).toBe(true);
  });

  it("putDEK with a duplicate jti zeroes the previous buffer", () => {
    const old = Buffer.alloc(32, 0x77);
    const fresh = Buffer.alloc(32, 0x99);
    putDEK("j-dup", old, TTL_MS, "u-dup");
    putDEK("j-dup", fresh, TTL_MS, "u-dup");
    // The OLD buffer should be zeroed even though we replaced its slot.
    expect(old.every((byte) => byte === 0)).toBe(true);
    // The FRESH buffer should still be intact and retrievable.
    expect(getDEK("j-dup", "u-dup")?.equals(fresh)).toBe(true);
  });
});

describe("DEK cache — evictAllForUser (B7 / H-7)", () => {
  beforeEach(() => {
    clearAllDEKs();
  });

  it("evicts every entry owned by a single user", () => {
    const aliceA = Buffer.alloc(32, 0x01);
    const aliceB = Buffer.alloc(32, 0x02);
    const bob = Buffer.alloc(32, 0x03);
    putDEK("alice-1", aliceA, TTL_MS, "alice");
    putDEK("alice-2", aliceB, TTL_MS, "alice");
    putDEK("bob-1", bob, TTL_MS, "bob");

    const evicted = evictAllForUser("alice");
    expect(evicted).toBe(2);

    expect(getDEK("alice-1", "alice")).toBeNull();
    expect(getDEK("alice-2", "alice")).toBeNull();
    // Bob unaffected.
    expect(getDEK("bob-1", "bob")?.equals(bob)).toBe(true);
  });

  it("zeroes the evicted user's buffers", () => {
    const dek = Buffer.alloc(32, 0xaa);
    putDEK("evict-me", dek, TTL_MS, "victim");
    evictAllForUser("victim");
    expect(dek.every((byte) => byte === 0)).toBe(true);
  });

  it("returns 0 when the user has no entries", () => {
    expect(evictAllForUser("ghost")).toBe(0);
  });
});
