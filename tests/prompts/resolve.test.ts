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
  /**
   * Chainable drizzle stub. `getPendingPrompts` issues its queries in a fixed
   * order — the onboarding gate first, then per prompt the predicate (settings
   * row) and the ack row — so the stub answers `.limit()` from a queue in that
   * order. The last entry repeats, so a short queue means "empty from here".
   */
  function stubDb(...results: unknown[][]) {
    let call = 0;
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () =>
      Promise.resolve(results[Math.min(call++, results.length - 1)] ?? []);
    return chain as never;
  }

  const ONBOARDED = [{ onboardingComplete: 1 }];

  it("surfaces display_currency when there is no settings row (absent ack)", async () => {
    const pending = await getPendingPrompts(stubDb(ONBOARDED, [], []), "user-1");
    expect(pending.map((p) => p.id)).toEqual(["display_currency"]);
    expect(pending[0]).toMatchObject({ version: 1, deferrable: true, deferCount: 0 });
  });

  it("does not surface display_currency once a settings row exists", async () => {
    const pending = await getPendingPrompts(
      stubDb(ONBOARDED, [{ value: "USD" }]),
      "user-1",
    );
    expect(pending).toEqual([]);
  });

  // Prompts are an EXISTING-user back-fill: the onboarding wizard asks its own
  // version of the same questions, so stacking a prompt dialog on top of it is
  // a double-ask. Onboarding (or a default) covers new users.
  it("returns nothing while the user is still in onboarding", async () => {
    const pending = await getPendingPrompts(
      stubDb([{ onboardingComplete: 0 }], []),
      "user-1",
    );
    expect(pending).toEqual([]);
  });

  it("treats a missing user row as onboarded rather than silently muting prompts", async () => {
    const pending = await getPendingPrompts(stubDb([], [], []), "user-1");
    expect(pending.map((p) => p.id)).toEqual(["display_currency"]);
  });
});
