/**
 * FINLYNQ-301 phase 1 — pending-prompt resolution.
 *
 * Pure-unit: exercises the ack-filter decision (`isAckPending`) across all four
 * states, and `getPendingPrompts` against an empty registry with a stub db.
 */

import { describe, it, expect } from "vitest";
import {
  isAckPending,
  getPendingPrompts,
  type AckRow,
} from "@/lib/prompts/resolve";

const NOW = new Date("2026-07-25T12:00:00Z");
const HOUR = 60 * 60 * 1000;

describe("isAckPending", () => {
  it("is pending when the ack row is absent", () => {
    expect(isAckPending({ maxDefers: null }, null, NOW)).toBe(true);
  });

  it("is terminal once answered", () => {
    const ack: AckRow = { status: "answered", deferCount: 0, deferredUntil: null };
    expect(isAckPending({ maxDefers: null }, ack, NOW)).toBe(false);
  });

  it("is terminal once dismissed", () => {
    const ack: AckRow = { status: "dismissed", deferCount: 1, deferredUntil: null };
    expect(isAckPending({ maxDefers: null }, ack, NOW)).toBe(false);
  });

  it("is pending again when a deferral has cooled down (under maxDefers)", () => {
    const ack: AckRow = {
      status: "deferred",
      deferCount: 1,
      deferredUntil: new Date(NOW.getTime() - HOUR), // in the past
    };
    expect(isAckPending({ maxDefers: null }, ack, NOW)).toBe(true);
    expect(isAckPending({ maxDefers: 3 }, ack, NOW)).toBe(true);
  });

  it("is suppressed while still within the deferral cooldown (deferred-hot)", () => {
    const ack: AckRow = {
      status: "deferred",
      deferCount: 1,
      deferredUntil: new Date(NOW.getTime() + HOUR), // in the future
    };
    expect(isAckPending({ maxDefers: null }, ack, NOW)).toBe(false);
  });

  it("null deferred_until reads as cooled down", () => {
    const ack: AckRow = { status: "deferred", deferCount: 0, deferredUntil: null };
    expect(isAckPending({ maxDefers: null }, ack, NOW)).toBe(true);
  });

  it("stops re-surfacing once defer_count reaches maxDefers", () => {
    const ack: AckRow = {
      status: "deferred",
      deferCount: 3,
      deferredUntil: new Date(NOW.getTime() - HOUR), // cooled down…
    };
    // …but at the cap, so no longer pending.
    expect(isAckPending({ maxDefers: 3 }, ack, NOW)).toBe(false);
  });
});

describe("getPendingPrompts", () => {
  it("returns [] for an empty registry without touching the db", async () => {
    // Stub db whose `.select` would throw if reached — the empty registry means
    // no predicate/ack query runs.
    const stubDb = {
      select() {
        throw new Error("db should not be queried for an empty registry");
      },
    } as never;
    await expect(getPendingPrompts(stubDb, "user-1")).resolves.toEqual([]);
  });
});
