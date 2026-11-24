// Tag + payee suggestions and the Payees & tags screen on the phone
// (2026-11-24). The rules mirror the web's (same cases as pf-app
// tests/tag-suggest.test.ts and tests/payees.test.ts), the fields keep one
// comma-separated value, and the screen calls the web's routes.
import React, { useState } from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import {
  applyTagSuggestion,
  currentTagToken,
  nearDuplicateTag,
  nearDuplicatesInValue,
  suggestTags,
  type TagOption,
} from "../lib/tag-suggest";
import { suggestPayees, type PayeeOption } from "../lib/payee-suggest";
import { affectedCount, filterNames, mergedMessage, resolveGroups, tagNameError } from "../lib/names-cleanup";
import { TagInput } from "../components/TagInput";
import { PayeeInput } from "../components/PayeeInput";
import { clearNameOptionsCache } from "../hooks/useNameOptions";
import PayeesTagsScreen from "../screens/PayeesTagsScreen";

const mockGoBack = jest.fn();
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ navigate: jest.fn(), goBack: mockGoBack }),
  useIsFocused: () => true,
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getTagOptions: jest.fn(),
    getPayeeOptions: jest.fn(),
    forgetPayee: jest.fn(),
    getPayeeUsage: jest.fn(),
    mergePayees: jest.fn(),
    movePayeesToNote: jest.fn(),
    getTagUsage: jest.fn(),
    replaceTags: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};
function themed(node: React.ReactElement) {
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>{node}</ThemeContext.Provider>
  );
}
const ok = <T,>(data: T) => ({ success: true, data });
const ep = endpoints as unknown as Record<string, jest.Mock>;

const TAGS: TagOption[] = [
  { tag: "Vacation", count: 12 },
  { tag: "Van", count: 2 },
  { tag: "work", count: 30 },
  { tag: "Renovation", count: 5 },
  { tag: "tax", count: 4 },
];
const PAYEES: PayeeOption[] = [
  { id: 1, name: "Corner Cafe", count: 9, categoryId: 4 },
  { id: 2, name: "Costco", count: 20, categoryId: 5 },
  { id: 3, name: "City Hydro", count: 3, categoryId: null },
  { id: 4, name: "Second Cup Coffee", count: 2, categoryId: 4 },
];

beforeEach(() => {
  jest.clearAllMocks();
  clearNameOptionsCache();
  ep.getTagOptions.mockResolvedValue(ok({ tags: TAGS, locked: false }));
  ep.getPayeeOptions.mockResolvedValue(ok({ payees: PAYEES, locked: false }));
  ep.forgetPayee.mockResolvedValue(ok({ removed: 1 }));
});

describe("tag rules (mirror of the web)", () => {
  it("suggests by prefix then contains, leaving out tags already in the field", () => {
    expect(currentTagToken("work, Vac")).toBe("Vac");
    expect(suggestTags(TAGS, "va").map((s) => s.tag)).toEqual(["Vacation", "Van", "Renovation"]);
    expect(suggestTags(TAGS, "vacation, va").map((s) => s.tag)).toEqual(["Van", "Renovation"]);
    expect(applyTagSuggestion("work, Vac", "Vacation")).toBe("work, Vacation, ");
  });
  it("flags near duplicates", () => {
    expect(nearDuplicateTag(TAGS, "vacation")).toBe("Vacation");
    expect(nearDuplicateTag(TAGS, "Vacations")).toBe("Vacation");
    expect(nearDuplicateTag(TAGS, "taxi")).toBeNull();
    expect(nearDuplicatesInValue(TAGS, "Vacations, work, Groceries")).toEqual([{ typed: "Vacations", existing: "Vacation" }]);
  });
});

describe("payee rules (mirror of the web)", () => {
  it("suggests by prefix then contains, nothing for empty or an exact single match", () => {
    expect(suggestPayees(PAYEES, "  ")).toEqual([]);
    expect(suggestPayees(PAYEES, "co").map((p) => p.name)).toEqual(["Costco", "Corner Cafe", "Second Cup Coffee"]);
    expect(suggestPayees(PAYEES, "City Hydro")).toEqual([]);
  });
});

describe("cleanup helpers", () => {
  const items = [
    { key: "a", name: "Braces Haven", count: 4, lastDate: null },
    { key: "b", name: "BRACES HAVEN NEPEAN", count: 2, lastDate: null },
  ];
  it("resolves groups, counts, filters and words results", () => {
    expect(resolveGroups({ items, groups: [["a", "b"], ["a", "gone"]], locked: false })).toEqual([items]);
    expect(affectedCount(items)).toBe(6);
    expect(filterNames(items, "nepean").map((i) => i.key)).toEqual(["b"]);
    expect(mergedMessage(2, "Braces Haven", 1)).toBe('Updated 2 transactions to "Braces Haven". Added 1 rule for future imports.');
    expect(tagNameError("a,b")).toMatch(/comma/);
  });
});

function TagHarness({ initial = "", seen }: { initial?: string; seen: string[] }) {
  const [v, setV] = useState(initial);
  return (
    <TagInput
      value={v}
      onValueChange={(n) => {
        setV(n);
        seen.push(n);
      }}
    />
  );
}

describe("TagInput", () => {
  it("shows saved tags as chips and finishes a tag on a comma", () => {
    const seen: string[] = [];
    const s = render(themed(<TagHarness initial="work, trip" seen={seen} />));
    expect(s.getAllByTestId("tag-chip")).toHaveLength(2);
    const input = s.getByLabelText("Tags");
    fireEvent.changeText(input, "groceries,");
    expect(seen.at(-1)).toBe("work, trip, groceries");
    expect(s.getAllByTestId("tag-chip")).toHaveLength(3);
  });

  it("the chip x removes a tag", () => {
    const seen: string[] = [];
    const s = render(themed(<TagHarness initial="a, b, c" seen={seen} />));
    fireEvent.press(s.getByLabelText("Remove tag b"));
    expect(seen.at(-1)).toBe("a, c");
  });

  it("suggests existing tags after focus and adds the picked one", async () => {
    const seen: string[] = [];
    const s = render(themed(<TagHarness initial="work" seen={seen} />));
    const input = s.getByLabelText("Tags");
    fireEvent(input, "focus");
    fireEvent.changeText(input, "vac");
    await waitFor(() => expect(s.getByLabelText("Add tag Vacation")).toBeTruthy());
    fireEvent.press(s.getByLabelText("Add tag Vacation"));
    expect(seen.at(-1)).toBe("work, Vacation");
  });
});

describe("PayeeInput", () => {
  it("suggests after typing and reports the picked payee", async () => {
    const picked: PayeeOption[] = [];
    function H() {
      const [v, setV] = useState("");
      return <PayeeInput value={v} onValueChange={setV} onPick={(p) => { setV(p.name); picked.push(p); }} />;
    }
    const s = render(themed(<H />));
    const input = s.getByLabelText("Payee");
    fireEvent(input, "focus");
    fireEvent.changeText(input, "co");
    await waitFor(() => expect(s.getByLabelText("Use payee Costco")).toBeTruthy());
    fireEvent.press(s.getByLabelText("Use payee Corner Cafe"));
    expect(picked).toEqual([PAYEES[0]]);
    expect(s.queryByLabelText("Use payee Costco")).toBeNull();
  });

  it("the x stops suggesting a payee", async () => {
    function H() {
      const [v, setV] = useState("");
      return <PayeeInput value={v} onValueChange={setV} />;
    }
    const s = render(themed(<H />));
    const input = s.getByLabelText("Payee");
    fireEvent(input, "focus");
    fireEvent.changeText(input, "co");
    await waitFor(() => expect(s.getByLabelText("Stop suggesting Costco")).toBeTruthy());
    fireEvent.press(s.getByLabelText("Stop suggesting Costco"));
    expect(ep.forgetPayee).toHaveBeenCalledWith(2);
    expect(s.queryByLabelText("Use payee Costco")).toBeNull();
  });
});

describe("PayeesTagsScreen", () => {
  const usage = {
    payees: [
      { key: "k1", name: "Braces Haven", count: 4, lastDate: "2026-11-01", variants: [], suggestionId: 11 },
      { key: "k2", name: "BRACES HAVEN NEPEAN", count: 2, lastDate: "2026-10-01", variants: [], suggestionId: null },
      { key: "k3", name: "Transfer to Savings", count: 3, lastDate: "2026-09-01", variants: [], suggestionId: null },
    ],
    groups: [["k1", "k2"]],
    locked: false,
  };

  beforeEach(() => {
    ep.getPayeeUsage.mockResolvedValue(ok(usage));
    ep.getTagUsage.mockResolvedValue(ok({ tags: [{ key: "trip", name: "trip", count: 2, lastDate: null }], groups: [], locked: false }));
    ep.mergePayees.mockResolvedValue(ok({ updated: 2, rulesAdded: 1 }));
    ep.movePayeesToNote.mockResolvedValue(ok({ updated: 3 }));
    ep.replaceTags.mockResolvedValue(ok({ updated: 2 }));
  });

  it("merges a duplicate group, with rules for future imports when asked", async () => {
    const s = render(themed(<PayeesTagsScreen />));
    await waitFor(() => expect(s.getByLabelText("Merge Braces Haven, BRACES HAVEN NEPEAN")).toBeTruthy());
    fireEvent.press(s.getByLabelText("Merge Braces Haven, BRACES HAVEN NEPEAN"));
    expect(s.getByText('6 transactions will get the payee "Braces Haven".')).toBeTruthy();
    fireEvent(s.getByLabelText("Also rename these on future imports"), "valueChange", true);
    await act(async () => {
      fireEvent.press(s.getByLabelText("Confirm merge"));
    });
    expect(ep.mergePayees).toHaveBeenCalledWith(["k1", "k2"], "Braces Haven", true);
    await waitFor(() =>
      expect(s.getByText('Updated 2 transactions to "Braces Haven". Added 1 rule for future imports.')).toBeTruthy(),
    );
  });

  it("moves a payee to the note after confirming", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const s = render(themed(<PayeesTagsScreen />));
    await waitFor(() => expect(s.getByLabelText("Transfer to Savings")).toBeTruthy());
    fireEvent.press(s.getByLabelText("Transfer to Savings"));
    fireEvent.press(s.getByLabelText("Move to note"));
    const buttons = alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => {
      buttons.find((b) => b.text === "Move")!.onPress!();
    });
    expect(ep.movePayeesToNote).toHaveBeenCalledWith(["k3"]);
    // A payee that is not suggested has no Remove.
    expect(s.queryByLabelText("Remove")).toBeNull();
    alert.mockRestore();
  });

  it("renames a tag on the Tags tab", async () => {
    const s = render(themed(<PayeesTagsScreen />));
    await waitFor(() => expect(s.getByText("Tags")).toBeTruthy());
    fireEvent.press(s.getByText("Tags"));
    await waitFor(() => expect(s.getByLabelText("trip")).toBeTruthy());
    fireEvent.press(s.getByLabelText("trip"));
    fireEvent.press(s.getByLabelText("Rename"));
    fireEvent.changeText(s.getByLabelText("New name"), "Trips");
    await act(async () => {
      fireEvent.press(s.getByLabelText("Confirm rename"));
    });
    expect(ep.replaceTags).toHaveBeenCalledWith(["trip"], "Trips");
  });
});
