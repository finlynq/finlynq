// Email imports on mobile (owner request 2026-10-15: emailed transactions
// could only be processed on the web).
import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import EmailImportsScreen from "../screens/EmailImportsScreen";
import EmailRecordScreen from "../screens/EmailRecordScreen";
import StagedImportScreen from "../screens/StagedImportScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import {
  buildEmailRecordBody,
  describeApproveResult,
  emailFormInit,
  emailsToRecord,
  flipAmountSign,
  parseAmountInput,
  stagedSourceLabel,
  stagedTitle,
} from "../lib/email-imports";
import type { EmailInboxItem, InboxAccount, StagedImportSummary } from "../../../shared/types";

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockReplace = jest.fn();
let mockRouteParams: unknown = undefined;
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useIsFocused: jest.fn(() => true),
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, replace: mockReplace }),
  useRoute: () => ({ key: "r", name: "r", params: mockRouteParams }),
}));

jest.mock("../api/client", () => ({
  endpoints: {
    getEmailInbox: jest.fn(),
    getStagedImports: jest.fn(),
    getInboxAccounts: jest.fn(),
    getCategories: jest.fn(),
    recordEmail: jest.fn(),
    discardEmail: jest.fn(),
    getStagedImport: jest.fn(),
    bindStagedImport: jest.fn(),
    approveStagedImport: jest.fn(),
    rejectStagedImport: jest.fn(),
  },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};
const wrap = (el: React.ReactElement) => (
  <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>{el}</ThemeContext.Provider>
);

const ep = endpoints as unknown as Record<string, jest.Mock>;
const ok = <T,>(data: T) => ({ success: true, data });
const alert = Alert.alert as jest.Mock;
const pressAlert = async (label: string) => {
  const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] as { text: string; onPress?: () => unknown }[];
  await act(async () => {
    await buttons.find((b) => b.text === label)?.onPress?.();
  });
};

function email(over: Partial<EmailInboxItem> = {}): EmailInboxItem {
  return {
    id: "e1",
    fromAddress: "alerts@bank.example",
    subject: "Card purchase",
    receivedAt: "2026-10-14T10:00:00Z",
    action: "needs_review",
    sourceKind: "body",
    parseConfidence: "high",
    matchedRuleId: null,
    recordedTransactionId: null,
    stagedImportId: "s1",
    candidate: { date: "2026-10-14", amount: -42.5, currency: "USD", payee: "Coffee Shop" },
    ...over,
  };
}

function file(over: Partial<StagedImportSummary> = {}): StagedImportSummary {
  return {
    id: "f1",
    source: "email",
    fromAddress: "statements@bank.example",
    subject: "Your October statement",
    receivedAt: "2026-10-14T10:00:00Z",
    totalRowCount: 3,
    duplicateCount: 1,
    expiresAt: "2026-12-14T10:00:00Z",
    originalFilename: "october.csv",
    fileFormat: "csv",
    boundAccountId: null,
    ...over,
  };
}

const accounts: InboxAccount[] = [
  { id: 1, name: "Chequing", currency: "USD", mode: "approve" },
  { id: 2, name: "Savings", currency: "USD", mode: "manual" },
  { id: 3, name: "Brokerage", currency: "USD", mode: "manual", isInvestment: true },
];
const categories = [
  { id: 10, type: "E", group: "Food", name: "Restaurants", note: "" },
  { id: 11, type: "I", group: "Income", name: "Salary", note: "" },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = undefined;
  ep.getInboxAccounts.mockResolvedValue(ok(accounts));
  ep.getCategories.mockResolvedValue(ok(categories));
});

describe("email-imports helpers", () => {
  it("lists only body emails still waiting, with something to record", () => {
    const items = [
      email({ id: "a" }),
      email({ id: "b", action: "manually_recorded" }),
      email({ id: "c", sourceKind: "attachment", candidate: null }),
      email({ id: "d", candidate: null }),
    ];
    expect(emailsToRecord(items).map((i) => i.id)).toEqual(["a"]);
  });

  it("sends only what the user changed, like the web tab", () => {
    const c = { date: "2026-10-14", amount: -42.5, currency: "USD", payee: "Coffee Shop" };
    const base = { ...emailFormInit(c), accountId: 1, categoryId: 10 };
    expect(buildEmailRecordBody(c, base)).toEqual({ ok: true, body: { action: "record", accountId: 1, categoryId: 10 } });
    expect(buildEmailRecordBody(c, { ...base, amount: "42,5", date: "2026-10-13", payee: " Café " }, { force: true })).toEqual({
      ok: true,
      body: { action: "record", accountId: 1, categoryId: 10, amount: 42.5, date: "2026-10-13", payee: "Café", force: true },
    });
  });

  it("books a transfer instead of a category when asked", () => {
    const c = { date: "2026-10-14", amount: -100, currency: "USD", payee: "Transfer" };
    const f = { ...emailFormInit(c), accountId: 1, mode: "transfer" as const, destAccountId: 2 };
    expect(buildEmailRecordBody(c, f)).toEqual({ ok: true, body: { action: "record", accountId: 1, transferDestAccountId: 2 } });
    expect(buildEmailRecordBody(c, { ...f, destAccountId: 1 })).toEqual({ ok: false, error: "A transfer needs two different accounts" });
  });

  it("says what is missing", () => {
    const c = { date: "2026-10-14", amount: -1, currency: "USD", payee: "X" };
    const f = emailFormInit(c);
    expect(buildEmailRecordBody(c, f)).toMatchObject({ ok: false, error: expect.stringMatching(/account/) });
    expect(buildEmailRecordBody(c, { ...f, accountId: 1 })).toEqual({ ok: false, error: "Choose a category" });
    expect(buildEmailRecordBody(c, { ...f, accountId: 1, categoryId: 10, amount: "" })).toEqual({ ok: false, error: "Enter the amount" });
  });

  it("flips signs and reads decimal commas", () => {
    expect(flipAmountSign("-12.5")).toBe("12.5");
    expect(flipAmountSign("12.5")).toBe("-12.5");
    expect(parseAmountInput("12,5")).toBe(12.5);
    expect(parseAmountInput("abc")).toBeNull();
  });

  it("names files and describes a send", () => {
    expect(stagedTitle({ subject: "", originalFilename: "oct.csv" })).toBe("oct.csv");
    expect(stagedSourceLabel({ source: "email" })).toBe("Emailed file");
    expect(describeApproveResult({ approved: 2, skippedDuplicates: 1, rowErrors: [] })).toBe(
      "2 transactions sent to the account. 1 already there, skipped.",
    );
  });
});

describe("EmailImportsScreen", () => {
  it("lists emails to record and statement files, and opens each", async () => {
    ep.getEmailInbox.mockResolvedValue(ok([email(), email({ id: "x", action: "auto_recorded" })]));
    ep.getStagedImports.mockResolvedValue(ok([file()]));
    const { getByText } = render(wrap(<EmailImportsScreen />));
    await waitFor(() => expect(getByText("Coffee Shop")).toBeTruthy());
    expect(getByText("Your October statement")).toBeTruthy();
    expect(getByText(/Emailed file · 3 rows · 1 already recorded/)).toBeTruthy();

    fireEvent.press(getByText("Coffee Shop"));
    expect(mockNavigate).toHaveBeenCalledWith("EmailRecord", { item: email() });
    fireEvent.press(getByText("Your October statement"));
    expect(mockNavigate).toHaveBeenCalledWith("StagedImport", { id: "f1", title: "Your October statement" });
  });

  it("says when nothing is waiting", async () => {
    ep.getEmailInbox.mockResolvedValue(ok([]));
    ep.getStagedImports.mockResolvedValue(ok([]));
    const { getByText } = render(wrap(<EmailImportsScreen />));
    await waitFor(() => expect(getByText("No emailed transactions waiting.")).toBeTruthy());
    expect(getByText("No statement files waiting.")).toBeTruthy();
  });

  it("shows the server's error", async () => {
    ep.getEmailInbox.mockResolvedValue({ success: false, error: "session_locked" });
    ep.getStagedImports.mockResolvedValue(ok([]));
    const { getByText } = render(wrap(<EmailImportsScreen />));
    await waitFor(() => expect(getByText("session_locked")).toBeTruthy());
  });
});

describe("EmailRecordScreen", () => {
  async function open(item = email()) {
    mockRouteParams = { item };
    const utils = render(wrap(<EmailRecordScreen />));
    await waitFor(() => expect(ep.getCategories).toHaveBeenCalled());
    return utils;
  }

  it("records into the chosen account and category, and passes on a sign warning", async () => {
    ep.recordEmail.mockResolvedValue(
      ok({ ok: true, action: "manually_recorded", transactionId: 5, warning: "Restaurants is an expense category, but this amount is positive." }),
    );
    const { getByLabelText, getByText, queryByText } = await open();
    // The brokerage is not offered: an email records into a plain account.
    fireEvent.press(getByLabelText("ACCOUNT: none"));
    expect(queryByText("Brokerage")).toBeNull();
    fireEvent.press(getByText("Chequing"));
    fireEvent.press(getByLabelText("CATEGORY: none"));
    fireEvent.press(getByText("Restaurants"));
    fireEvent.press(getByLabelText("Flip sign"));
    await act(async () => {
      fireEvent.press(getByLabelText("Record"));
    });
    expect(ep.recordEmail).toHaveBeenCalledWith("e1", { action: "record", accountId: 1, categoryId: 10, amount: 42.5 });
    expect(alert).toHaveBeenCalledWith("Recorded", expect.stringContaining("expense category"));
    expect(mockGoBack).toHaveBeenCalled();
  });

  it("offers Record anyway for a possible duplicate", async () => {
    ep.recordEmail
      .mockResolvedValueOnce(ok({ ok: false, action: "possible_duplicate", duplicateOfTransactionId: 77 }))
      .mockResolvedValueOnce(ok({ ok: true, action: "manually_recorded", transactionId: 6 }));
    const { getByLabelText, getByText } = await open();
    fireEvent.press(getByLabelText("ACCOUNT: none"));
    fireEvent.press(getByText("Chequing"));
    fireEvent.press(getByLabelText("CATEGORY: none"));
    fireEvent.press(getByText("Restaurants"));
    await act(async () => {
      fireEvent.press(getByLabelText("Record"));
    });
    expect(getByText(/already in the account \(#77\)/)).toBeTruthy();
    expect(mockGoBack).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(getByText("Record anyway"));
    });
    expect(ep.recordEmail).toHaveBeenLastCalledWith("e1", expect.objectContaining({ force: true }));
    expect(mockGoBack).toHaveBeenCalled();
  });

  it("asks for what is missing before calling the server", async () => {
    const { getByLabelText, getByText } = await open();
    await act(async () => {
      fireEvent.press(getByLabelText("Record"));
    });
    expect(getByText(/Choose the account/)).toBeTruthy();
    expect(ep.recordEmail).not.toHaveBeenCalled();
  });

  it("discards after confirming", async () => {
    ep.discardEmail.mockResolvedValue(ok({ ok: true }));
    const { getByText } = await open();
    fireEvent.press(getByText("Discard this email"));
    await pressAlert("Discard");
    expect(ep.discardEmail).toHaveBeenCalledWith("e1");
    expect(mockGoBack).toHaveBeenCalled();
  });
});

describe("StagedImportScreen", () => {
  const detail = (boundAccountId: number | null) => ({
    staged: { id: "f1", status: "pending", boundAccountId },
    rows: [
      { id: "r1", date: "2026-10-01", amount: -20, currency: "USD", payee: "Grocer", isDuplicate: false },
      { id: "r2", date: "2026-10-02", amount: 1000, currency: "USD", payee: "Employer", isDuplicate: false },
      { id: "r3", date: "2026-10-03", amount: -5, currency: "USD", payee: "Cafe", isDuplicate: true },
    ],
  });

  it("asks for the account first, then sends the new rows", async () => {
    mockRouteParams = { id: "f1", title: "Your October statement" };
    ep.getStagedImport.mockResolvedValueOnce(ok(detail(null))).mockResolvedValue(ok(detail(1)));
    ep.bindStagedImport.mockResolvedValue(ok({ ok: true, accountId: 1, accountName: "Chequing", rowsRebound: 3 }));
    ep.approveStagedImport.mockResolvedValue(ok({ approved: 2, skippedDuplicates: 1, rowErrors: [] }));
    const { getByText, getByLabelText } = render(wrap(<StagedImportScreen />));
    await waitFor(() => expect(getByText("Choose the account first")).toBeTruthy());
    expect(getByText(/3 rows · 1 already recorded/)).toBeTruthy();

    fireEvent.press(getByLabelText("Choose the account"));
    await act(async () => {
      fireEvent.press(getByText("Chequing"));
    });
    expect(ep.bindStagedImport).toHaveBeenCalledWith("f1", 1);
    await waitFor(() => expect(getByText("Send 2 to Chequing")).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByText("Send 2 to Chequing"));
    });
    expect(ep.approveStagedImport).toHaveBeenCalledWith("f1");
    expect(alert).toHaveBeenCalledWith("Sent", expect.stringContaining("2 transactions sent"), expect.any(Array));
    await pressAlert("Open Reconcile");
    expect(mockReplace).toHaveBeenCalledWith("Inbox", { accountId: 1 });
  });

  it("discards the file after confirming", async () => {
    mockRouteParams = { id: "f1", title: "Oct" };
    ep.getStagedImport.mockResolvedValue(ok(detail(1)));
    ep.rejectStagedImport.mockResolvedValue(ok({ ok: true }));
    const { getByText } = render(wrap(<StagedImportScreen />));
    await waitFor(() => expect(getByText("Discard this file")).toBeTruthy());
    fireEvent.press(getByText("Discard this file"));
    await pressAlert("Discard");
    expect(ep.rejectStagedImport).toHaveBeenCalledWith("f1");
    expect(mockGoBack).toHaveBeenCalled();
  });
});
