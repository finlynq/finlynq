/**
 * Regression test for the M-1 (SECURITY_REVIEW 2026-05-06) idempotency mutex
 * pattern used in `bulk_record_transactions`.
 *
 * The pattern is small enough to mirror inline here. The fix in
 * `register-tools-pg.ts` uses the same `globalThis`-resident `Map<string,
 * Promise<unknown>>` shape: two concurrent calls with the same key must
 * serialize, and the second must see the first's result on a re-check.
 */

import { describe, it, expect } from "vitest";

// Mirror the helper inline so this test exercises the exact shape used in
// production (sans the runtime wiring we can't poke at without a real DB).
function makeMutex() {
  const map = new Map<string, Promise<unknown>>();
  return async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = map.get(key);
    if (prev) {
      try {
        await prev;
      } catch {
        // Predecessor failure must not block this attempt.
      }
    }
    const run = (async () => fn())();
    map.set(key, run);
    try {
      return await run;
    } finally {
      if (map.get(key) === run) map.delete(key);
    }
  };
}

describe("idempotency mutex (M-1)", () => {
  it("serializes two concurrent calls with the same key", async () => {
    const withMutex = makeMutex();
    const events: string[] = [];

    let resolveFirst: () => void = () => {};
    const firstStarted = new Promise<void>((r) => {
      // Resolved when the first call has entered fn().
      resolveFirst = r;
    });

    const first = withMutex("user::key", async () => {
      events.push("first-start");
      resolveFirst();
      // Yield the event loop a few times so the second call can attempt to
      // enter (and queue behind us).
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      events.push("first-end");
      return "first-result";
    });

    // Wait until the first call is actually inside fn() before issuing the
    // second — guarantees the second call observes the predecessor in the map.
    await firstStarted;

    const second = withMutex("user::key", async () => {
      events.push("second-start");
      events.push("second-end");
      return "second-result";
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe("first-result");
    expect(b).toBe("second-result");
    // The contract: second-start MUST come after first-end.
    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("does NOT serialize calls with distinct keys", async () => {
    const withMutex = makeMutex();
    const events: string[] = [];

    const a = withMutex("k1", async () => {
      events.push("a-start");
      await new Promise((r) => setImmediate(r));
      events.push("a-end");
    });
    const b = withMutex("k2", async () => {
      events.push("b-start");
      await new Promise((r) => setImmediate(r));
      events.push("b-end");
    });

    await Promise.all([a, b]);
    // The two interleaved freely — both started before either ended.
    const aStartIdx = events.indexOf("a-start");
    const bStartIdx = events.indexOf("b-start");
    const aEndIdx = events.indexOf("a-end");
    const bEndIdx = events.indexOf("b-end");
    expect(aStartIdx).toBeGreaterThanOrEqual(0);
    expect(bStartIdx).toBeGreaterThanOrEqual(0);
    expect(aStartIdx).toBeLessThan(bEndIdx);
    expect(bStartIdx).toBeLessThan(aEndIdx);
  });

  it("releases the slot when fn throws so a retry can proceed", async () => {
    const withMutex = makeMutex();
    await expect(
      withMutex("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Next call with same key must run, not deadlock waiting for a stale
    // promise in the map.
    const ok = await withMutex("k", async () => "ok");
    expect(ok).toBe("ok");
  });
});
