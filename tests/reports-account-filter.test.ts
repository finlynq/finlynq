/**
 * Account scoping for the Reports page.
 *
 * The load-bearing rule is "empty means ALL, not NONE". Get it backwards and a
 * user who unticks the last account gets a completely blank report while the
 * filter chip still says something is selected — the same class of lie as the
 * admin table's unfiltered count, and the reason the admin column filters
 * already forbid an empty filter reaching the wire.
 */

import { describe, it, expect } from "vitest";
import {
  parseAccountIdsParam,
  serializeAccountIds,
  accountFilterLabel,
  ACCOUNT_IDS_PARAM,
} from "@/lib/reports/account-filter";

describe("parseAccountIdsParam", () => {
  it("parses a comma-separated list", () => {
    expect(parseAccountIdsParam("3,1,2")).toEqual([1, 2, 3]);
  });

  it("de-dupes and sorts so the same selection yields one canonical filter", () => {
    expect(parseAccountIdsParam("5,5,2,5")).toEqual([2, 5]);
  });

  it("tolerates whitespace", () => {
    expect(parseAccountIdsParam(" 4 , 7 ")).toEqual([4, 7]);
  });

  it.each([null, undefined, "", "   "])("returns null (= all accounts) for %p", (v) => {
    expect(parseAccountIdsParam(v as string | null)).toBeNull();
  });

  it("degrades a fully-garbled param to null rather than an empty report", () => {
    // An empty id list server-side means "match nothing". Returning [] here
    // would render a blank report with no explanation.
    expect(parseAccountIdsParam("abc,,-1,0,1.5")).toBeNull();
  });

  it("keeps the valid ids from a partly-garbled param", () => {
    expect(parseAccountIdsParam("9,abc,-2,11")).toEqual([9, 11]);
  });

  it("rejects non-integers and non-positives", () => {
    expect(parseAccountIdsParam("0")).toBeNull();
    expect(parseAccountIdsParam("-3")).toBeNull();
    expect(parseAccountIdsParam("2.7")).toBeNull();
  });
});

describe("serializeAccountIds", () => {
  it("round-trips through the parser", () => {
    const ids = [8, 2, 5];
    const serialized = serializeAccountIds(ids)!;
    expect(parseAccountIdsParam(serialized)).toEqual([2, 5, 8]);
  });

  it("returns null for an empty selection so the param is OMITTED", () => {
    // Not `""` — a bare `accountIds=` would parse to null anyway, but omitting
    // it keeps the request URL honest about there being no filter.
    expect(serializeAccountIds([])).toBeNull();
    expect(serializeAccountIds(null)).toBeNull();
    expect(serializeAccountIds(undefined)).toBeNull();
  });

  it("drops invalid ids", () => {
    expect(serializeAccountIds([1, 0, -4, 2.5, 3])).toBe("1,3");
  });
});

describe("accountFilterLabel", () => {
  it("says All accounts when nothing is selected", () => {
    expect(accountFilterLabel([], 6)).toBe("All accounts");
  });

  it("says All accounts when everything is selected", () => {
    // Selecting all N is the same state as selecting none; the label must not
    // claim a filter is narrowing anything.
    expect(accountFilterLabel([1, 2, 3], 3)).toBe("All accounts");
  });

  it("singularizes one account", () => {
    expect(accountFilterLabel([4], 6)).toBe("1 account");
  });

  it("counts a partial selection", () => {
    expect(accountFilterLabel([1, 2], 6)).toBe("2 accounts");
  });

  it("does not claim All accounts before the account list has loaded", () => {
    // total=0 means the fetch hasn't resolved; a selection must still read as
    // a selection rather than flipping to "All accounts" for a frame.
    expect(accountFilterLabel([1, 2], 0)).toBe("2 accounts");
  });
});

describe("param name", () => {
  it("is shared so every endpoint reads the same key", () => {
    expect(ACCOUNT_IDS_PARAM).toBe("accountIds");
  });
});
