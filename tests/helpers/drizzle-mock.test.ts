import { describe, it, expect, vi } from "vitest";
import { createDrizzleMock } from "./api-test-utils";

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
    const chain = createDrizzleMock(rows);
    const composed = (chain.select as ReturnType<typeof vi.fn>)()
      .from("t")
      .where("x = 1")
      .orderBy("id");
    await expect(Promise.resolve(composed)).resolves.toEqual(rows);
  });

  it("insert().values().returning() chain stays composable and awaitable", async () => {
    const rows = [{ id: 1 }];
    const chain = createDrizzleMock(rows);
    const composed = (chain.insert as ReturnType<typeof vi.fn>)()
      .values({ id: 1 })
      .returning();
    await expect(Promise.resolve(composed)).resolves.toEqual(rows);
  });

  it(".all() returns the rows array (legacy SQLite terminator parity)", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const chain = createDrizzleMock(rows);
    expect((chain.all as ReturnType<typeof vi.fn>)()).toEqual(rows);
  });

  it(".get() returns the first row when supplied an array", () => {
    const rows = [{ id: 7 }, { id: 8 }];
    const chain = createDrizzleMock(rows);
    expect((chain.get as ReturnType<typeof vi.fn>)()).toEqual({ id: 7 });
  });
});
