/** The scenario picker lists variants under their parent, one level deeper. Pure. */
import { describe, it, expect } from "vitest";
import { scenarioTree } from "@/app/(app)/forecast/_components/scenario-bar";

const s = (id: number, name: string, parent: { type: string; id?: number } | null, unreadable = false) =>
  ({ id, name, kind: parent ? "variant" : "base", parent, unreadable });

describe("scenarioTree", () => {
  it("puts a variant right under its parent, one level deeper", () => {
    const list = [
      s(3, "aaa", { type: "scenario", id: 1 }),
      s(1, "Verify phase 2", { type: "builtin" }),
      s(2, "My own", null),
      s(4, "bbb", { type: "scenario", id: 3 }),
    ];
    expect(scenarioTree(list).map(({ scenario, depth }) => [scenario.name, depth])).toEqual([
      ["Verify phase 2", 1],
      ["aaa", 2],
      ["bbb", 3],
      ["My own", 0],
    ]);
  });

  it("lists a variant whose parent is gone at the end, and skips unreadable ones", () => {
    const list = [s(5, "orphan", { type: "scenario", id: 99 }), s(6, "hidden", null, true), s(7, "base", null)];
    expect(scenarioTree(list).map(({ scenario, depth }) => [scenario.name, depth])).toEqual([["base", 0], ["orphan", 1]]);
  });
});
