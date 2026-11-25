/** Compare panel wording: milestone shifts and whether a difference is good news. Pure. */
import { describe, it, expect } from "vitest";
import { differenceTone, milestoneShift } from "@/app/(app)/forecast/_components/compare-panel";

describe("milestoneShift", () => {
  it("says how a milestone moves in the compared forecast", () => {
    expect(milestoneShift("2026-12", "2026-12").text).toBe("Same month");
    expect(milestoneShift("2026-12", "2027-01").text).toBe("1 month later");
    expect(milestoneShift("2028-06", "2027-06").text).toBe("1 year earlier");
    expect(milestoneShift("2028-06", "2026-06").text).toBe("2 years earlier");
    expect(milestoneShift("2026-12", null).text).toBe("Only in this forecast");
    expect(milestoneShift(null, "2030-01").text).toBe("Only in the compared one");
  });
});

describe("differenceTone", () => {
  it("more income is good, more spending or debt is bad", () => {
    expect(differenceTone("income", 100)).toBe("good");
    expect(differenceTone("income", -100)).toBe("bad");
    expect(differenceTone("expense", 100)).toBe("bad");
    expect(differenceTone("expense", -100)).toBe("good");
    expect(differenceTone("debt", 50)).toBe("bad");
  });
});
