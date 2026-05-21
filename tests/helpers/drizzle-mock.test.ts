import { describe, it, expect } from "vitest";
import { createDrizzleMock } from "./api-test-utils";

// Chain methods on the mock are typed as `unknown` (the helper returns
// Record<string, unknown>); cast to `any` for call-site ergonomics — a mock
// helper is the right place for the looser typing.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChainAny = any;

describe("createDrizzleMock — Drizzle proxy shape regression test (FINLYNQ-9)", () => {
  it("awaiting the chain resolves to [] by default", async () => {
    const chain = createDrizzleMock();
    await expect(Promise.resolve(chain)).resolves.toEqual([]);
  });

  it("awaiting the chain resolves to the supplied array", async () => {
    const rows = [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }];
    const chain = createDrizzleMock(rows);
    await expect(Promise.resolve(chain)).resolves.toEqual(rows);
  });

  it("awaiting a non-array argument resolves to [] (defensive default)", async () => {
    const chain = createDrizzleMock({ not: "an-array" } as unknown);
    await expect(Promise.resolve(chain)).resolves.toEqual([]);
  });

  it("composed chain remains awaitable through select().from().where().orderBy()", async () => {
    const rows = [{ id: 42 }];
    const chain: ChainAny = createDrizzleMock(rows);
    const composed = chain.select().from("t").where("x = 1").orderBy("id");
    await expect(Promise.resolve(composed)).resolves.toEqual(rows);
  });

  it("insert().values().returning() chain stays composable and awaitable", async () => {
    const rows = [{ id: 1 }];
    const chain: ChainAny = createDrizzleMock(rows);
    const composed = chain.insert().values({ id: 1 }).returning();
    await expect(Promise.resolve(composed)).resolves.toEqual(rows);
  });

  it(".all() returns the rows array (legacy SQLite terminator parity)", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const chain: ChainAny = createDrizzleMock(rows);
    expect(chain.all()).toEqual(rows);
  });

  it(".get() returns the first row when supplied an array", () => {
    const rows = [{ id: 7 }, { id: 8 }];
    const chain: ChainAny = createDrizzleMock(rows);
    expect(chain.get()).toEqual({ id: 7 });
  });
});
