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
  // Chainable drizzle stub: every `.select().from().where().limit()` resolves to
  // the same `rows`. getPendingPrompts issues one predicate query (settings row)
  // and, when it applies, one ack query — both see `rows`.
  function stubDb(rows: unknown[]) {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () => Promise.resolve(rows);
    return chain as never;
  }

  it("surfaces display_currency when there is no settings row (absent ack)", async () => {
    const pending = await getPendingPrompts(stubDb([]), "user-1");
    expect(pending.map((p) => p.id)).toEqual(["display_currency"]);
    expect(pending[0]).toMatchObject({ version: 1, deferrable: true, deferCount: 0 });
  });

  it("does not surface display_currency once a settings row exists", async () => {
    const pending = await getPendingPrompts(stubDb([{ value: "USD" }]), "user-1");
    expect(pending).toEqual([]);
  });
});
