import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import BudgetsScreen, { monthFromOffset } from "../screens/BudgetsScreen";
import { endpoints } from "../api/client";
import { leftToSpendSection } from "../lib/widgets/snapshot";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import type { BudgetGroup, BudgetLine, BudgetMonth } from "../lib/budgets";

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: jest.fn(() => true),
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getBudgetMonth: jest.fn(),
    setBudgetLine: jest.fn(),
    setBudgetSettings: jest.fn(),
    setBudgetCarryover: jest.fn(),
    fillBudgets: jest.fn(),
    getLoans: jest.fn(),
  },
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function renderScreen() {
  return render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <BudgetsScreen />
    </ThemeContext.Provider>,
  );
}

function line(over: Partial<BudgetLine> & { categoryId: number; name: string }): BudgetLine {
  return {
    key: `c:${over.categoryId}`,
    budgeted: null,
    actual: 0,
    carriedIn: null,
    left: null,
    rollover: false,
    rolloverNegative: "carry",
    average3: 0,
    upcoming: 0,
    status: "unbudgeted",
    ...over,
  };
}

function group(over: Partial<BudgetGroup> & { key: string; name: string; lines: BudgetLine[] }): BudgetGroup {
  return {
    byGroup: false,
    rollover: false,
    rolloverNegative: "carry",
    budgeted: null,
    actual: 0,
    carriedIn: null,
    left: null,
    upcoming: 0,
    average3: 0,
    status: "ok",
    ...over,
  };
}

// A month shaped like the one that started this: some spending has no budget
// behind it (Transport, 215.50), so a list of budgets alone would undercount.
const month = (m: string = monthFromOffset(0), overrides: Partial<BudgetMonth> = {}): BudgetMonth => ({
  month: m,
  currency: "USD",
  today: `${m}-15`,
  summary: {
    plannedIncome: 5000,
    receivedIncome: 2500,
    plannedSpending: 3000,
    spent: 1715.5,
    plannedDebt: 400,
    paidDebt: 400,
    leftToPlan: 1600,
    netCashFlow: 384.5,
    upcoming: 30,
  },
  counts: { notBudgeted: 2, overspent: 1, withUpcoming: 1 },
  income: [
    group({
      key: "g:income:Income",
      name: "Income",
      actual: 2500,
      lines: [
        line({ categoryId: 10, name: "Salary", budgeted: 5000, actual: 2500, left: 2500, status: "expected" }),
        line({ categoryId: 11, name: "Side gig" }),
      ],
    }),
  ],
  debt: [
    {
      accountId: 50,
      name: "Car Loan",
      planned: 400,
      paid: 400,
      principal: 340,
      interest: 60,
      bookedInterest: 60,
      dueDates: [`${m}-05`],
      status: "paid",
      source: "schedule",
      loanIds: [7],
    },
  ],
  spending: [
    group({
      key: "g:Needs",
      name: "Needs",
      budgeted: 2800,
      actual: 1215.5,
      left: 1800,
      lines: [
        line({ categoryId: 1, name: "Groceries", budgeted: 2800, actual: 1000, left: 1800, status: "ok", upcoming: 30, average3: 900 }),
        line({ categoryId: 3, name: "Transport", actual: 215.5, average3: 180 }),
      ],
    }),
    group({
      key: "g:Fun",
      name: "Fun",
      byGroup: true,
      budgeted: 200,
      actual: 250,
      left: -50,
      status: "over",
      average3: 240,
      lines: [
        line({ categoryId: 4, name: "Dining", actual: 150, status: "ok" }),
        line({ categoryId: 5, name: "Movies", actual: 100, status: "ok" }),
      ],
    }),
    group({
      key: "g:Other",
      name: "Other",
      lines: [line({ categoryId: 6, name: "Gifts" })],
    }),
  ],
  excluded: [
    { key: "c:20", categoryId: 20, name: "Reimbursed", group: "Work", type: "E", by: "category" },
    { key: "c:21", categoryId: 21, name: "Rent out", group: "Business", type: "E", by: "group" },
  ],
  ...overrides,
});

function mockLoad(data: BudgetMonth = month()) {
  (endpoints.getBudgetMonth as jest.Mock).mockResolvedValue({ success: true, data });
}

describe("monthFromOffset", () => {
  it("does not skip a month from the 31st", () => {
    // setMonth on Jan 31 overflows to March; day-1 construction must not.
    expect(monthFromOffset(1, new Date(2026, 0, 31))).toBe("2026-02");
    expect(monthFromOffset(-1, new Date(2026, 2, 31))).toBe("2026-02");
    expect(monthFromOffset(0, new Date(2026, 4, 31))).toBe("2026-05");
  });

  it("rolls the year over in both directions", () => {
    expect(monthFromOffset(1, new Date(2026, 11, 31))).toBe("2027-01");
    expect(monthFromOffset(-1, new Date(2026, 0, 15))).toBe("2025-12");
  });
});

describe("BudgetsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    for (const fn of [endpoints.setBudgetLine, endpoints.setBudgetSettings, endpoints.setBudgetCarryover]) {
      (fn as jest.Mock).mockResolvedValue({ success: true, data: {} });
    }
  });

  it("shows a loading indicator first", () => {
    (endpoints.getBudgetMonth as jest.Mock).mockReturnValue(new Promise(() => {}));
    const { UNSAFE_queryAllByType } = renderScreen();
    const { ActivityIndicator } = require("react-native");
    expect(UNSAFE_queryAllByType(ActivityIndicator).length).toBeGreaterThan(0);
  });

  describe("totals", () => {
    it("shows the figures the Left to spend widget shows", async () => {
      const data = month();
      mockLoad(data);
      const widget = leftToSpendSection(data, 0);
      // What the phone's home screen shows for this response, the 215.50 of
      // spending with no budget behind it included.
      expect(widget).toMatchObject({ leftLabel: "$1,284.50", plannedLabel: "$3,000.00", spentLabel: "$1,715.50", tone: "ok" });

      const { getByText } = renderScreen();
      await waitFor(() => expect(getByText("Left to spend")).toBeTruthy());
      expect(getByText(widget.leftLabel)).toBeTruthy();
      expect(getByText(`Spent ${widget.spentLabel} of ${widget.plannedLabel}`)).toBeTruthy();
    });

    it("says how far over when the month is over budget, like the widget", async () => {
      const data = month();
      data.summary = { ...data.summary, plannedSpending: 1000, spent: 1200 };
      mockLoad(data);
      const widget = leftToSpendSection(data, 0);
      expect(widget.tone).toBe("over");

      const { getByText, queryByText } = renderScreen();
      await waitFor(() => expect(getByText("Over budget")).toBeTruthy());
      expect(getByText(widget.leftLabel)).toBeTruthy();
      expect(widget.leftLabel).toBe("$200.00");
      expect(queryByText("Left to spend")).toBeNull();
    });

    it("shows what was spent when nothing is budgeted, like the widget", async () => {
      const data = month();
      data.summary = { ...data.summary, plannedSpending: 0, spent: 250 };
      mockLoad(data);
      const widget = leftToSpendSection(data, 0);

      const { getByText, getAllByText } = renderScreen();
      await waitFor(() => expect(getByText("Spent this month")).toBeTruthy());
      expect(getAllByText(widget.spentLabel).length).toBeGreaterThan(0);
    });

    it("shows the rest of the month: left to plan, income, debt, net", async () => {
      mockLoad();
      const { getByText } = renderScreen();
      await waitFor(() => expect(getByText("Left to plan")).toBeTruthy());
      expect(getByText("$1,600.00")).toBeTruthy();
      expect(getByText("Income received")).toBeTruthy();
      expect(getByText("Debt paid")).toBeTruthy();
      expect(getByText("+$384.50")).toBeTruthy();
      expect(getByText("Still due this month")).toBeTruthy();
    });

    it("formats in the month's currency", async () => {
      mockLoad({ ...month(), currency: "CAD" });
      const { getByText } = renderScreen();
      await waitFor(() => expect(getByText("C$1,284.50")).toBeTruthy());
    });
  });

  describe("the list", () => {
    it("lists every income and expense category, budgeted or not", async () => {
      mockLoad();
      const { getByText } = renderScreen();
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());
      for (const name of ["Salary", "Side gig", "Transport", "Dining", "Movies", "Gifts"]) {
        expect(getByText(name)).toBeTruthy();
      }
    });

    it("says how a line stands, in short rows", async () => {
      mockLoad();
      const { getByText, getAllByText } = renderScreen();
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());
      expect(getAllByText("$1,800.00 left").length).toBe(2); // The line and its group.
      expect(getByText("$1,000.00 of $2,800.00 · $30.00 due later")).toBeTruthy();
      expect(getByText("$215.50 spent · avg $180")).toBeTruthy();
      expect(getAllByText("Not budgeted").length).toBe(3); // Side gig, Transport, Gifts
      expect(getByText("$2,500.00 to come")).toBeTruthy();
    });

    it("shows a debt line as the server returns it and opens its loan", async () => {
      mockLoad();
      const loan = { id: 7, name: "Car Loan", remainingBalance: 1000 };
      (endpoints.getLoans as jest.Mock).mockResolvedValue({ success: true, data: [loan] });
      const { getByText, getByLabelText } = renderScreen();
      await waitFor(() => expect(getByText("Car Loan")).toBeTruthy());
      expect(getByText("Debt payments")).toBeTruthy();
      expect(getByText("$400.00 of $400.00 · $60.00 interest")).toBeTruthy();
      expect(getByText("Paid")).toBeTruthy();

      fireEvent.press(getByLabelText("Car Loan loan"));
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("LoanDetail", { loan }));
    });

    it("falls back to the Loans list when the loan can't be read", async () => {
      mockLoad();
      (endpoints.getLoans as jest.Mock).mockResolvedValue({ success: false, error: "x" });
      const { getByLabelText } = renderScreen();
      await waitFor(() => expect(getByLabelText("Car Loan loan")).toBeTruthy());
      fireEvent.press(getByLabelText("Car Loan loan"));
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("Loans"));
    });

    it("shows a group budgeted as one line, with its categories inside and no budget of their own", async () => {
      mockLoad();
      const { getByText, getByLabelText, queryByLabelText } = renderScreen();
      await waitFor(() => expect(getByText("One budget")).toBeTruthy());
      expect(getByText("$50.00 over")).toBeTruthy();
      expect(getByText("$250.00 of $200.00")).toBeTruthy();
      // Dining's row shows what it spent; it can't be budgeted on its own.
      expect(getByText("$150.00")).toBeTruthy();
      fireEvent.press(getByLabelText("Dining"));
      await waitFor(() => expect(getByText("Its spending counts in its group's budget.")).toBeTruthy());
      expect(queryByLabelText("Budget amount")).toBeNull();
    });

    it("hides a collapsed group's lines and remembers it", async () => {
      mockLoad();
      const { getByText, getByLabelText, queryByText } = renderScreen();
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());

      fireEvent.press(getByLabelText("Hide Needs"));
      await waitFor(() => expect(queryByText("Groceries")).toBeNull());
      expect(getByText(/· 2 categories$/)).toBeTruthy();
      expect(AsyncStorage.setItem).toHaveBeenCalledWith("pf_budget_collapsed", JSON.stringify(["g:Needs"]));

      fireEvent.press(getByLabelText("Show Needs"));
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());
    });

    it("starts with what was collapsed last time", async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify(["section:debt", "g:Needs"]));
      mockLoad();
      const { getByText, queryByText } = renderScreen();
      await waitFor(() => expect(getByText("Gifts")).toBeTruthy());
      await waitFor(() => expect(queryByText("Groceries")).toBeNull());
      expect(queryByText("Car Loan")).toBeNull();
      expect(getByText("Debt payments")).toBeTruthy();
    });
  });

  describe("filters", () => {
    it("shows the categories still missing a budget, income included, and opens collapsed groups", async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify(["g:Needs"]));
      mockLoad();
      const { getByText, getByLabelText, queryByText } = renderScreen();
      await waitFor(() => expect(getByText("Gifts")).toBeTruthy());

      // Two spending lines from the server's count, plus Side gig.
      fireEvent.press(getByLabelText("Not budgeted: 3"));
      await waitFor(() => expect(getByText("Transport")).toBeTruthy());
      expect(getByText("Side gig")).toBeTruthy();
      expect(getByText("Gifts")).toBeTruthy();
      for (const hidden of ["Groceries", "Salary", "Car Loan", "Dining"]) expect(queryByText(hidden)).toBeNull();
    });

    it("narrows to overspent lines", async () => {
      mockLoad();
      const { getByText, getByLabelText, queryByText } = renderScreen();
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());

      fireEvent.press(getByLabelText("Overspent: 1"));
      await waitFor(() => expect(queryByText("Groceries")).toBeNull());
      expect(getByText("Dining")).toBeTruthy();
      expect(queryByText("Salary")).toBeNull();
    });

    it("says so when a filter finds nothing", async () => {
      const data = month();
      data.counts = { notBudgeted: 0, overspent: 0, withUpcoming: 0 };
      data.income = [];
      data.spending = [group({ key: "g:Needs", name: "Needs", lines: [line({ categoryId: 1, name: "Groceries", budgeted: 10, left: 10, status: "ok" })] })];
      mockLoad(data);
      const { getByText, getByLabelText } = renderScreen();
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());
      fireEvent.press(getByLabelText("Overspent: 0"));
      await waitFor(() => expect(getByText("Nothing to show for this filter this month.")).toBeTruthy());
    });
  });

  describe("setting a budget", () => {
    async function openLine(name: string) {
      mockLoad();
      const q = renderScreen();
      await waitFor(() => expect(q.getByText(name)).toBeTruthy());
      fireEvent.press(q.getByLabelText(`Budget for ${name}`));
      await waitFor(() => expect(q.getByLabelText("Save budget")).toBeTruthy());
      return q;
    }

    it("saves through the shared route, reloads and closes", async () => {
      const q = await openLine("Transport");
      const calls = (endpoints.getBudgetMonth as jest.Mock).mock.calls.length;

      fireEvent.changeText(q.getByLabelText("Budget amount"), "1,250.50");
      fireEvent.press(q.getByLabelText("Save budget"));

      await waitFor(() => expect(endpoints.setBudgetLine).toHaveBeenCalledWith("c:3", monthFromOffset(0), 1250.5));
      await waitFor(() => expect(q.queryByLabelText("Save budget")).toBeNull());
      expect((endpoints.getBudgetMonth as jest.Mock).mock.calls.length).toBe(calls + 1);
    });

    it("clears the budget when the field is left empty", async () => {
      const q = await openLine("Groceries");
      const field = q.getByLabelText("Budget amount");
      expect(field.props.value).toBe("2800");
      fireEvent.changeText(field, "");
      fireEvent.press(q.getByLabelText("Save budget"));
      await waitFor(() => expect(endpoints.setBudgetLine).toHaveBeenCalledWith("c:1", monthFromOffset(0), null));
    });

    it("refuses what isn't an amount, without calling the server", async () => {
      const q = await openLine("Transport");
      fireEvent.changeText(q.getByLabelText("Budget amount"), "-5");
      fireEvent.press(q.getByLabelText("Save budget"));
      await waitFor(() => expect(q.getByText(/Enter 0 or more/)).toBeTruthy());
      expect(endpoints.setBudgetLine).not.toHaveBeenCalled();
    });

    it("keeps the sheet open with what was typed when the save fails", async () => {
      (endpoints.setBudgetLine as jest.Mock).mockResolvedValue({ success: false, error: "Server said no" });
      const q = await openLine("Transport");
      fireEvent.changeText(q.getByLabelText("Budget amount"), "300");
      fireEvent.press(q.getByLabelText("Save budget"));
      await waitFor(() => expect(q.getByText("Server said no")).toBeTruthy());
      expect(q.getByLabelText("Budget amount").props.value).toBe("300");
    });

    it("says so when the connection drops during a save", async () => {
      (endpoints.setBudgetLine as jest.Mock).mockRejectedValue(new Error("boom"));
      const q = await openLine("Transport");
      fireEvent.changeText(q.getByLabelText("Budget amount"), "300");
      fireEvent.press(q.getByLabelText("Save budget"));
      await waitFor(() => expect(q.getByText("Cannot connect to server")).toBeTruthy());
    });

    it("saves once however many times Save is pressed", async () => {
      let finish: (v: unknown) => void = () => {};
      (endpoints.setBudgetLine as jest.Mock).mockReturnValue(new Promise((r) => (finish = r)));
      const q = await openLine("Transport");
      fireEvent.changeText(q.getByLabelText("Budget amount"), "300");
      const save = q.getByLabelText("Save budget");
      fireEvent.press(save);
      fireEvent.press(q.getByLabelText("Save budget"));
      expect(endpoints.setBudgetLine).toHaveBeenCalledTimes(1);
      await act(async () => finish({ success: true, data: {} }));
    });

    it("offers the 3-month average and leaves saving to you", async () => {
      const q = await openLine("Transport");
      fireEvent.press(q.getByText("Use the 3-month average ($180)"));
      await waitFor(() => expect(q.getByLabelText("Budget amount").props.value).toBe("180"));
      expect(endpoints.setBudgetLine).not.toHaveBeenCalled();
    });

    it("clears this month's budget from the sheet", async () => {
      const q = await openLine("Groceries");
      fireEvent.press(q.getByText("Clear this month's budget"));
      await waitFor(() => expect(endpoints.setBudgetLine).toHaveBeenCalledWith("c:1", monthFromOffset(0), null));
    });

    it("writes a one-line group under its stored name", async () => {
      mockLoad();
      const q = renderScreen();
      await waitFor(() => expect(q.getByText("One budget")).toBeTruthy());
      fireEvent.press(q.getByLabelText("Budget for the Fun group"));
      await waitFor(() => expect(q.getByLabelText("Save budget")).toBeTruthy());
      fireEvent.changeText(q.getByLabelText("Budget amount"), "275");
      fireEvent.press(q.getByLabelText("Save budget"));
      await waitFor(() => expect(endpoints.setBudgetLine).toHaveBeenCalledWith("g:Fun", monthFromOffset(0), 275));
    });

    it("sets expected income on an income line", async () => {
      mockLoad();
      const q = renderScreen();
      await waitFor(() => expect(q.getByText("Side gig")).toBeTruthy());
      fireEvent.press(q.getByLabelText("Expected income from Side gig"));
      await waitFor(() => expect(q.getByText(/^EXPECTED FOR/)).toBeTruthy());
      fireEvent.changeText(q.getByLabelText("Expected amount"), "800");
      fireEvent.press(q.getByLabelText("Save budget"));
      await waitFor(() => expect(endpoints.setBudgetLine).toHaveBeenCalledWith("c:11", monthFromOffset(0), 800));
      // Income has no rollover.
      expect(q.queryByLabelText("Roll leftover into next month")).toBeNull();
    });

    it("opens the category's history", async () => {
      const q = await openLine("Transport");
      fireEvent.press(q.getByText("See this category's spending"));
      expect(mockNavigate).toHaveBeenCalledWith("CategoryDetail", { categoryId: 3, name: "Transport" });
    });
  });

  describe("rollover and leaving out", () => {
    async function openLine(name: string, data: BudgetMonth = month()) {
      mockLoad(data);
      const q = renderScreen();
      await waitFor(() => expect(q.getByText(name)).toBeTruthy());
      fireEvent.press(q.getByLabelText(`Budget for ${name}`));
      await waitFor(() => expect(q.getByLabelText("Save budget")).toBeTruthy());
      return q;
    }

    const rolling = () => {
      const data = month();
      data.spending[0].lines[0] = { ...data.spending[0].lines[0], rollover: true, carriedIn: 20, left: 1820 };
      return data;
    };

    it("turns rollover on from the month on screen", async () => {
      const q = await openLine("Groceries");
      fireEvent(q.getByLabelText("Roll leftover into next month"), "valueChange", true);
      await waitFor(() =>
        expect(endpoints.setBudgetSettings).toHaveBeenCalledWith({
          target: { categoryId: 1 },
          month: monthFromOffset(0),
          rollover: true,
        }),
      );
    });

    it("shows what was carried in, and resets it to 0 from this month", async () => {
      const q = await openLine("Groceries", rolling());
      expect(q.getByText(/Carried in \$20\.00/)).toBeTruthy();
      fireEvent.press(q.getByText("Reset carryover to 0 from this month"));
      await waitFor(() => expect(endpoints.setBudgetCarryover).toHaveBeenCalledWith("c:1", monthFromOffset(0), 0));
    });

    it("stops carrying overspending", async () => {
      const q = await openLine("Groceries", rolling());
      fireEvent(q.getByLabelText("Carry overspending too"), "valueChange", false);
      await waitFor(() =>
        expect(endpoints.setBudgetSettings).toHaveBeenCalledWith({
          target: { categoryId: 1 },
          month: monthFromOffset(0),
          rolloverNegative: "reset",
        }),
      );
    });

    it("rolls a one-line group over by its stored name", async () => {
      mockLoad();
      const q = renderScreen();
      await waitFor(() => expect(q.getByText("One budget")).toBeTruthy());
      fireEvent.press(q.getByLabelText("Budget for the Fun group"));
      await waitFor(() => expect(q.getByLabelText("Save budget")).toBeTruthy());
      fireEvent(q.getByLabelText("Roll leftover into next month"), "valueChange", true);
      await waitFor(() =>
        expect(endpoints.setBudgetSettings).toHaveBeenCalledWith({
          target: { group: "Fun" },
          month: monthFromOffset(0),
          rollover: true,
        }),
      );
    });

    it("leaves a category out of the budget", async () => {
      const q = await openLine("Transport");
      fireEvent.press(q.getByText("Leave out of the budget"));
      await waitFor(() =>
        expect(endpoints.setBudgetSettings).toHaveBeenCalledWith({
          target: { categoryId: 3 },
          month: monthFromOffset(0),
          excluded: true,
        }),
      );
      await waitFor(() => expect(q.queryByLabelText("Save budget")).toBeNull());
    });

    it("lists what is left out and brings it back", async () => {
      mockLoad();
      const q = renderScreen();
      await waitFor(() => expect(q.getByText(/Show 2 categories left out/)).toBeTruthy());
      expect(q.queryByText("Reimbursed")).toBeNull();

      fireEvent.press(q.getByText(/Show 2 categories left out/));
      await waitFor(() => expect(q.getByText("Reimbursed")).toBeTruthy());
      expect(q.getByText("Business")).toBeTruthy(); // A whole group comes back as one.

      fireEvent.press(q.getByLabelText("Bring back Reimbursed"));
      await waitFor(() =>
        expect(endpoints.setBudgetSettings).toHaveBeenCalledWith({
          target: { categoryId: 20 },
          month: monthFromOffset(0),
          excluded: false,
        }),
      );

      fireEvent.press(q.getByLabelText("Bring back Business"));
      await waitFor(() =>
        expect(endpoints.setBudgetSettings).toHaveBeenCalledWith({
          target: { group: "Business" },
          month: monthFromOffset(0),
          excluded: false,
        }),
      );
    });
  });

  describe("fill", () => {
    const preview = {
      rows: [{ key: "c:3", name: "Transport", month: "2026-11", amount: 180, previous: null }],
      applied: false,
      total: 180,
      currency: "USD",
    };

    async function openFill() {
      mockLoad();
      const q = renderScreen();
      await waitFor(() => expect(q.getByLabelText("Fill budgets")).toBeTruthy());
      fireEvent.press(q.getByLabelText("Fill budgets"));
      await waitFor(() => expect(q.getByText("Preview")).toBeTruthy());
      return q;
    }

    it("previews, then saves only what was shown, for this month's empty lines", async () => {
      (endpoints.fillBudgets as jest.Mock).mockResolvedValue({ success: true, data: preview });
      const q = await openFill();

      fireEvent.press(q.getByText("Preview"));
      await waitFor(() => expect(q.getByText("Save 1 budget")).toBeTruthy());
      expect(endpoints.fillBudgets).toHaveBeenLastCalledWith({
        months: [monthFromOffset(0)],
        source: { kind: "average", months: 3 },
        overwrite: false,
        scope: { kind: "all" },
        section: "spending",
        preview: true,
      });
      expect(q.getByText(/1 budget, \$180\.00 in all/)).toBeTruthy();

      fireEvent.press(q.getByText("Save 1 budget"));
      await waitFor(() => expect(q.getByText("Saved 1 budget.")).toBeTruthy());
      expect(endpoints.fillBudgets).toHaveBeenLastCalledWith(expect.objectContaining({ preview: false, overwrite: false }));
      expect(q.queryByText("Fill budgets")).toBeNull();
    });

    it("drops the preview when the source changes", async () => {
      (endpoints.fillBudgets as jest.Mock).mockResolvedValue({ success: true, data: preview });
      const q = await openFill();
      fireEvent.press(q.getByText("Preview"));
      await waitFor(() => expect(q.getByText("Save 1 budget")).toBeTruthy());

      fireEvent.press(q.getByText("Last month's budget"));
      await waitFor(() => expect(q.getByText("Preview")).toBeTruthy());
      fireEvent.press(q.getByText("Preview"));
      await waitFor(() =>
        expect(endpoints.fillBudgets).toHaveBeenLastCalledWith(expect.objectContaining({ source: { kind: "budget" }, preview: true })),
      );
    });

    it("says when there is nothing to fill, and offers nothing to save", async () => {
      (endpoints.fillBudgets as jest.Mock).mockResolvedValue({ success: true, data: { ...preview, rows: [], total: 0 } });
      const q = await openFill();
      fireEvent.press(q.getByText("Preview"));
      await waitFor(() => expect(q.getByText(/Nothing to fill from this source/)).toBeTruthy());
      expect(q.queryByText(/^Save /)).toBeNull();
    });

    it("keeps the sheet open when the server refuses", async () => {
      (endpoints.fillBudgets as jest.Mock).mockResolvedValue({ success: false, error: "Nope" });
      const q = await openFill();
      fireEvent.press(q.getByText("Preview"));
      await waitFor(() => expect(q.getByText("Nope")).toBeTruthy());
      expect(q.getByText("Preview")).toBeTruthy();
    });
  });

  describe("months and failures", () => {
    it("clears the previous month's rows when the next month fails to load", async () => {
      mockLoad();
      const { getByText, queryByText } = renderScreen();
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());

      (endpoints.getBudgetMonth as jest.Mock).mockResolvedValueOnce({ success: false, error: "Server exploded" });
      fireEvent.press(getByText("Next →"));

      await waitFor(() => expect(getByText("Server exploded")).toBeTruthy());
      expect(queryByText("Groceries")).toBeNull();
      expect(endpoints.getBudgetMonth).toHaveBeenLastCalledWith(monthFromOffset(1));
    });

    it("keeps the rows when a refresh of the same month fails, and says so", async () => {
      mockLoad();
      const { getByText, UNSAFE_getByType } = renderScreen();
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());

      (endpoints.getBudgetMonth as jest.Mock).mockResolvedValueOnce({ success: false, error: "Blip" });
      const { FlatList } = require("react-native");
      await act(async () => UNSAFE_getByType(FlatList).props.refreshControl.props.onRefresh());

      await waitFor(() => expect(getByText("Blip")).toBeTruthy());
      expect(getByText("Groceries")).toBeTruthy();
    });

    it("ignores a slow response for a month you already left", async () => {
      mockLoad();
      const { getByText, queryByText } = renderScreen();
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());

      let finishOld: (v: unknown) => void = () => {};
      (endpoints.getBudgetMonth as jest.Mock).mockReturnValueOnce(new Promise((r) => (finishOld = r)));
      fireEvent.press(getByText("Next →"));
      const later = month(monthFromOffset(2));
      later.spending = [group({ key: "g:Later", name: "Later", lines: [line({ categoryId: 90, name: "Later line" })] })];
      (endpoints.getBudgetMonth as jest.Mock).mockResolvedValueOnce({ success: true, data: later });
      fireEvent.press(getByText("Next →"));
      await waitFor(() => expect(getByText("Later line")).toBeTruthy());

      await act(async () => finishOld({ success: true, data: month(monthFromOffset(1)) }));
      expect(getByText("Later line")).toBeTruthy();
      expect(queryByText("Groceries")).toBeNull();
    });

    it("comes back to this month", async () => {
      mockLoad();
      const { getByText, queryByText } = renderScreen();
      await waitFor(() => expect(getByText("Groceries")).toBeTruthy());
      expect(queryByText("This month")).toBeNull();

      fireEvent.press(getByText("← Prev"));
      await waitFor(() => expect(getByText("This month")).toBeTruthy());
      fireEvent.press(getByText("This month"));
      await waitFor(() => expect(endpoints.getBudgetMonth).toHaveBeenLastCalledWith(monthFromOffset(0)));
    });

    it("explains a server too old to have the month route", async () => {
      (endpoints.getBudgetMonth as jest.Mock).mockResolvedValue({ success: false, error: "HTTP 404" });
      const { getByText } = renderScreen();
      await waitFor(() => expect(getByText(/need a newer Finlynq server/)).toBeTruthy());
    });

    it("reports a dropped connection", async () => {
      (endpoints.getBudgetMonth as jest.Mock).mockRejectedValue(new Error("offline"));
      const { getByText } = renderScreen();
      await waitFor(() => expect(getByText("Cannot connect to server")).toBeTruthy());
    });
  });
});
