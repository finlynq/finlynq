/**
 * createKeyedLimiter caps concurrent calls per key (2026-11-13). It is what
 * keeps one user's burst of reconcile snapshots from taking every database
 * connection, so the guarantees pinned here are: never more than `limit` in
 * flight for a key, other keys never wait, a failure frees its slot, and
 * waiters start in arrival order.
 */

import { describe, it, expect } from "vitest";
import { createKeyedLimiter } from "@/lib/concurrency/keyed-limiter";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createKeyedLimiter", () => {
  it("never runs more than `limit` calls at once for one key", async () => {
    const lim = createKeyedLimiter(3);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 10 }, deferred);
    const all = gates.map((g) =>
      lim.run("u1", async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      }),
    );
    await tick();
    expect(running).toBe(3);
    expect(lim.pending("u1")).toBe(10);
    for (const g of gates) {
      g.resolve();
      await tick();
    }
    await Promise.all(all);
    expect(peak).toBe(3);
    expect(lim.pending("u1")).toBe(0);
  });

  it("does not make another key wait", async () => {
    const lim = createKeyedLimiter(1);
    const hold = deferred();
    const busy = lim.run("u1", () => hold.promise);
    let otherRan = false;
    await lim.run("u2", async () => {
      otherRan = true;
    });
    expect(otherRan).toBe(true);
    hold.resolve();
    await busy;
  });

  it("frees the slot when a call throws", async () => {
    const lim = createKeyedLimiter(1);
    await expect(lim.run("u1", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(lim.pending("u1")).toBe(0);
    expect(await lim.run("u1", async () => 7)).toBe(7);
  });

  it("starts waiters in arrival order", async () => {
    const lim = createKeyedLimiter(1);
    const order: number[] = [];
    const first = deferred();
    const runs = [
      lim.run("u1", async () => {
        order.push(0);
        await first.promise;
      }),
      ...[1, 2, 3].map((n) => lim.run("u1", async () => void order.push(n))),
    ];
    await tick();
    expect(order).toEqual([0]);
    first.resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("refuses a limit below 1", () => {
    expect(() => createKeyedLimiter(0)).toThrow();
  });
});
