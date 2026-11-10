import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import BudgetRulesScreen, { draftToInput, emptyRuleDraft, RULES_ROUTE_MISSING, ruleToDraft } from "../screens/BudgetRulesScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import {
  addMonths,
  describeIncrease,
  parseSignedAmount,
  ruleMade,
  ruleRange,
  shortMonth,
  type LineRulesView,
} from "../lib/budgets";

jest.mock("../api/client", () => ({
  endpoints: {
    getBudgetRules: jest.fn(),
    createBudgetRule: jest.fn(),
    updateBudgetRule: jest.fn(),
    deleteBudgetRule: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

const goBack = jest.fn();
function renderScreen() {
  const props = {
    navigation: { goBack, navigate: jest.fn() },
    route: { key: "r", name: "BudgetRules", params: { lineKey: "c:7", name: "Salary", month: "2026-11" } },
  } as unknown as React.ComponentProps<typeof BudgetRulesScreen>;
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <BudgetRulesScreen {...props} />
    </ThemeContext.Provider>,
  );
}

const view = (over: Partial<LineRulesView> = {}): LineRulesView => ({
  key: "c:7",
  currency: "USD",
  from: "2026-11",
  rules: [
    {
      id: 3,
      key: "c:7",
      amount: 100,
      currency: "USD",
      startMonth: "2026-10",
      endMonth: null,
      increase: { mode: "percent", value: 3, every: "year", stepMonth: 1 },
      fromMonthAmount: 100,
    },
  ],
  months: Array.from({ length: 12 }, (_, i) => {
    const m = addMonths("2026-11", i);
    const fromRules = i >= 2 ? 103 : 100;
    return { month: m, fromRules, adjustment: i === 0 ? -20 : 0, override: false, total: fromRules + (i === 0 ? -20 : 0) };
  }),
  ...over,
});

describe("budget rule helpers", () => {
  it("describes an increase", () => {
    const fmt = (n: number) => `$${n}`;
    expect(describeIncrease({ mode: "percent", value: 3, every: "year", stepMonth: 1 }, fmt)).toBe("+3% every January");
    expect(describeIncrease({ mode: "amount", value: -25, every: "month" }, fmt)).toBe("−$25 every month");
    expect(describeIncrease(null, fmt)).toBe("");
  });

  it("names a rule's months", () => {
    expect(ruleRange("2026-10", "2027-07")).toBe("Oct 2026 to Jul 2027");
    expect(ruleRange("2027-01", null)).toBe("from Jan 2027, no end");
    expect(shortMonth("2026-12")).toBe("Dec 2026");
  });

  it("moves months across years", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2027-01", -1)).toBe("2026-12");
    expect(addMonths("2026-05", -17)).toBe("2024-12");
  });

  it("reads a signed amount with a decimal comma", () => {
    expect(parseSignedAmount("-12,50")).toBe(-12.5);
    expect(parseSignedAmount("−40")).toBe(-40);
    expect(parseSignedAmount("1,200")).toBe(1200);
    expect(parseSignedAmount("")).toBeNull();
    expect(parseSignedAmount("-")).toBe("invalid");
    expect(parseSignedAmount("x")).toBe("invalid");
  });

  it("knows when rules make a month", () => {
    expect(ruleMade({ ruleCount: 1, fromRules: 100, adjustment: 0, override: false, open: true })).toBe(true);
    expect(ruleMade({ ruleCount: 1, fromRules: null, adjustment: 0, override: true, open: true })).toBe(true);
    expect(ruleMade({ ruleCount: 1, fromRules: null, adjustment: 0, override: false, open: true })).toBe(false);
    expect(ruleMade({ ruleCount: 1, fromRules: 100, adjustment: 0, override: false, open: false })).toBe(false);
    expect(ruleMade(undefined)).toBe(false);
  });

  it("turns a draft into what the server takes", () => {
    const d = { ...emptyRuleDraft("2026-11"), amount: "1,000", incMode: "percent" as const, incValue: "3", every: "year" as const, stepMonth: 4 };
    expect(draftToInput(d)).toEqual({ amount: 1000, startMonth: "2026-11", endMonth: null, increase: { mode: "percent", value: 3, every: "year", stepMonth: 4 } });
    expect(draftToInput({ ...d, noEnd: false, endMonth: "2026-10" })).toEqual({ error: "The end month is before the start month." });
    expect(draftToInput({ ...d, amount: "" })).toEqual({ error: "Enter an amount of 0 or more." });
    expect(draftToInput({ ...d, incValue: "" })).toEqual({ error: "Enter the increase." });
    expect(draftToInput({ ...d, incMode: "none" })).toMatchObject({ increase: null });
  });

  it("edits a rule as it is stored", () => {
    const d = ruleToDraft(view().rules[0]);
    expect(d).toMatchObject({ id: 3, amount: "100", startMonth: "2026-10", noEnd: true, incMode: "percent", incValue: "3", stepMonth: 1 });
  });
});

describe("BudgetRulesScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (endpoints.getBudgetRules as jest.Mock).mockResolvedValue({ success: true, data: view() });
    for (const fn of [endpoints.createBudgetRule, endpoints.updateBudgetRule, endpoints.deleteBudgetRule]) {
      (fn as jest.Mock).mockResolvedValue({ success: true, data: { id: 9 } });
    }
  });

  it("lists the line's rules and its next 12 months", async () => {
    const q = renderScreen();
    await waitFor(() => expect(q.getByText(/\$100\.00 a month/)).toBeTruthy());
    expect(endpoints.getBudgetRules).toHaveBeenCalledWith("c:7", "2026-11");
    expect(q.getByText(/\+3% every January/)).toBeTruthy();
    expect(q.getByText(/from Oct 2026, no end/)).toBeTruthy();
    expect(q.getByText("Jan 2027")).toBeTruthy();
    expect(q.getByText("$80.00")).toBeTruthy();
    // The typed adjustment, written by formatCurrency (whatever minus sign it uses).
    expect(q.getByText(/^[-−]\$20\.00$/)).toBeTruthy();
  });

  it("adds a rule from the month shown, then reloads", async () => {
    const q = renderScreen();
    await waitFor(() => expect(q.getByText("Add a rule")).toBeTruthy());
    fireEvent.press(q.getByText("Add a rule"));
    fireEvent.changeText(q.getByLabelText("Amount a month"), "250");
    fireEvent.press(q.getByLabelText("Later start month"));
    fireEvent(q.getByLabelText("No end"), "valueChange", false);
    fireEvent.press(q.getByLabelText("Later end month"));
    fireEvent.press(q.getByLabelText("Later end month"));
    fireEvent.press(q.getByText("By an amount"));
    fireEvent.changeText(q.getByLabelText("Amount"), "10");
    fireEvent.press(q.getByText("Every month"));
    fireEvent.press(q.getByLabelText("Add rule"));
    await waitFor(() =>
      expect(endpoints.createBudgetRule).toHaveBeenCalledWith("c:7", {
        amount: 250,
        startMonth: "2026-12",
        endMonth: "2027-02", // starts at the start month (Dec), then two later
        increase: { mode: "amount", value: 10, every: "month" },
      }),
    );
    await waitFor(() => expect(endpoints.getBudgetRules).toHaveBeenCalledTimes(2));
  });

  it("edits a rule with every field sent", async () => {
    const q = renderScreen();
    await waitFor(() => expect(q.getByLabelText("Edit rule")).toBeTruthy());
    fireEvent.press(q.getByLabelText("Edit rule"));
    fireEvent.changeText(q.getByLabelText("Amount a month"), "120");
    fireEvent.press(q.getByLabelText("Save rule"));
    await waitFor(() =>
      expect(endpoints.updateBudgetRule).toHaveBeenCalledWith(3, {
        amount: 120,
        startMonth: "2026-10",
        endMonth: null,
        increase: { mode: "percent", value: 3, every: "year", stepMonth: 1 },
      }),
    );
  });

  it("asks before deleting a rule", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => {
      const del = buttons?.find((b) => b.style === "destructive");
      del?.onPress?.();
    });
    const q = renderScreen();
    await waitFor(() => expect(q.getByLabelText("Delete rule")).toBeTruthy());
    fireEvent.press(q.getByLabelText("Delete rule"));
    expect(alert.mock.calls[0][1]).toMatch(/Months that have ended keep their budgets/);
    await waitFor(() => expect(endpoints.deleteBudgetRule).toHaveBeenCalledWith(3));
    alert.mockRestore();
  });

  it("keeps the form and says why when the server refuses", async () => {
    (endpoints.createBudgetRule as jest.Mock).mockResolvedValue({ success: false, error: "Category not found." });
    const q = renderScreen();
    await waitFor(() => expect(q.getByText("Add a rule")).toBeTruthy());
    fireEvent.press(q.getByText("Add a rule"));
    fireEvent.changeText(q.getByLabelText("Amount a month"), "5");
    fireEvent.press(q.getByLabelText("Add rule"));
    await waitFor(() => expect(q.getByText("Category not found.")).toBeTruthy());
    expect(q.getByLabelText("Amount a month").props.value).toBe("5");
  });

  it("says the server needs updating when it has no budget rules", async () => {
    (endpoints.getBudgetRules as jest.Mock).mockResolvedValue({ success: false, error: "HTTP 404" });
    const q = renderScreen();
    await waitFor(() => expect(q.getByText(RULES_ROUTE_MISSING)).toBeTruthy());
  });
});
