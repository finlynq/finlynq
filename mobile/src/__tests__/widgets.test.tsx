// Home-screen widgets (GH #392).
import fs from "fs";
import path from "path";
import React from "react";
import { Linking } from "react-native";
import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react-native";
import { endpoints, getSession } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import { WIDGET_LINKS, widgetLinkTarget } from "../lib/widgets/links";
import {
  MAX_UPCOMING_ITEMS,
  WIDGET_SNAPSHOT_VERSION,
  leftToSpendSection,
  loansToSchedule,
  mergeSnapshot,
  netWorthSection,
  parseSnapshot,
  upcomingSection,
  type WidgetSnapshot,
} from "../lib/widgets/snapshot";
import { WIDGET_SYNC_MIN_INTERVAL_MS, resetWidgetSyncForTests, syncWidgets } from "../lib/widgets/sync";
import type { RecurringRow, SubscriptionRow } from "../lib/subscriptions";
import type { LoanSummary } from "../../../shared/types";
import WidgetsScreen, { WIDGETS_HOW_TO_ADD } from "../screens/WidgetsScreen";
import { useWidgetLinks } from "../hooks/useWidgets";
import * as native from "../../modules/finlynq-widgets";

const mockNavigationRef = {
  isReady: jest.fn(() => true),
  getRootState: jest.fn(() => ({ routeNames: ["Home", "More", "Transactions"] }) as { routeNames: string[] } | undefined),
  navigate: jest.fn(),
};

jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useNavigationContainerRef: () => mockNavigationRef,
}));

jest.mock("../api/client", () => ({
  getSession: jest.fn(),
  setMutationListener: jest.fn(),
  endpoints: {
    getBudgetMonth: jest.fn(),
    getSubscriptions: jest.fn(),
    getRecurring: jest.fn(),
    getLoans: jest.fn(),
    getLoanSchedule: jest.fn(),
    getDashboard: jest.fn(),
  },
}));

// The native module is present here (the default mock is the iOS case).
jest.mock("../../modules/finlynq-widgets", () => ({
  __esModule: true,
  widgetsAvailable: true,
  hasSnapshotReaders: jest.fn(() => true),
  readSnapshot: jest.fn(() => null),
  writeSnapshot: jest.fn(() => Promise.resolve()),
  clearSnapshot: jest.fn(() => Promise.resolve()),
  getHideAmounts: jest.fn(() => false),
  setHideAmounts: jest.fn(() => Promise.resolve()),
  canPinWidgets: jest.fn(() => true),
  pinWidget: jest.fn(() => true),
}));

const NOW = 1762300800000;
const TODAY = "2026-11-04";

function sub(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return { id: 1, name: "Spotify", amount: -15.81, currency: "CAD", frequency: "monthly", nextDate: "2026-11-10", status: "active", ...over };
}

function detected(over: Partial<RecurringRow> = {}): RecurringRow {
  return {
    payee: "Hydro One",
    avgAmount: -148.22,
    currency: "CAD",
    frequency: "monthly",
    count: 6,
    lastDate: "2026-10-07",
    nextDate: "2026-11-07",
    accountId: 1,
    categoryId: 2,
    ...over,
  };
}

function loan(over: Partial<LoanSummary> = {}): LoanSummary {
  return {
    id: 7,
    name: "Car loan",
    type: "loan",
    currency: "USD",
    principal: 30000,
    annualRate: 5,
    termMonths: 60,
    startDate: "2025-01-15",
    paymentFrequency: "monthly",
    monthlyPayment: 566,
    totalInterest: 3000,
    payoffDate: "2030-01-15",
    remainingBalance: 20000,
    balanceSource: "projection",
    principalPaid: 10000,
    interestPaid: 1000,
    periodsRemaining: 38,
    accountId: null,
    accountName: null,
    ...over,
  };
}

describe("left to spend", () => {
  const budget = (plannedSpending: number, spent: number) => ({ month: "2026-11", currency: "CAD", summary: { plannedSpending, spent } });

  it("is planned spending minus what was spent, in the budget's currency", () => {
    const s = leftToSpendSection(budget(3000, 1715.5), NOW);
    expect(s).toMatchObject({ month: "2026-11", hasBudget: true, tone: "ok", leftLabel: "C$1,284.50", plannedLabel: "C$3,000.00", spentLabel: "C$1,715.50", asOfMs: NOW });
    expect(s.usedFraction).toBeCloseTo(0.5718, 3);
  });

  it("turns amber at 80% used and red when over, showing how far over", () => {
    expect(leftToSpendSection(budget(1000, 799), NOW).tone).toBe("ok");
    expect(leftToSpendSection(budget(1000, 800), NOW).tone).toBe("warn");
    expect(leftToSpendSection(budget(1000, 1000), NOW).tone).toBe("warn");
    const over = leftToSpendSection(budget(1000, 1200), NOW);
    expect(over.tone).toBe("over");
    expect(over.leftLabel).toBe("C$200.00");
  });

  it("with nothing budgeted says so and is never over", () => {
    expect(leftToSpendSection(budget(0, 250), NOW)).toMatchObject({ hasBudget: false, tone: "ok", usedFraction: 0, spentLabel: "C$250.00" });
  });

  it("a month of refunds does not read as a negative share", () => {
    expect(leftToSpendSection(budget(100, -40), NOW).usedFraction).toBe(0);
  });
});

describe("upcoming payments", () => {
  it("lists subscriptions, detected series and loans, soonest first, each amount in its own currency", () => {
    const s = upcomingSection(
      [sub()],
      [detected()],
      [{ loan: loan(), schedule: [{ date: "2026-10-15", payment: 566 }, { date: "2026-11-15", payment: 566 }, { date: "2026-12-15", payment: 566 }] }],
      TODAY,
      NOW,
    )!;
    expect(s.items.map((i) => [i.date, i.name, i.amountLabel, i.kind])).toEqual([
      ["2026-11-07", "Hydro One", "C$148.22", "detected"],
      ["2026-11-10", "Spotify", "C$15.81", "subscription"],
      ["2026-11-15", "Car loan", "$566.00", "loan"],
    ]);
    expect(s.items[2].link).toBe(WIDGET_LINKS.loans);
    expect(s.items[0].link).toBe(WIDGET_LINKS.subscriptions);
  });

  it("shows a weekly bill once, at its next date", () => {
    const s = upcomingSection([sub({ frequency: "weekly", nextDate: "2026-11-05" })], [], [], TODAY, NOW)!;
    expect(s.items.map((i) => i.date)).toEqual(["2026-11-05"]);
  });

  it("a bill first due next month does not show this month", () => {
    const s = upcomingSection([sub({ nextDate: "2026-12-25" })], [], [], TODAY, NOW)!;
    expect(s.items.map((i) => i.date)).toEqual(["2026-12-25"]);
  });

  it("rolls a date that has passed forward to its next occurrence", () => {
    const s = upcomingSection([sub({ nextDate: "2026-10-10" })], [detected({ nextDate: "2026-10-07" })], [], TODAY, NOW)!;
    expect(s.items.map((i) => i.date)).toEqual(["2026-11-07", "2026-11-10"]);
  });

  it("does not list a detected series the user already tracks", () => {
    const s = upcomingSection([sub({ name: "Hydro One" })], [detected()], [], TODAY, NOW)!;
    expect(s.items.map((i) => i.kind)).toEqual(["subscription"]);
  });

  it("includes a payment due today", () => {
    const s = upcomingSection([sub({ nextDate: TODAY })], [], [], TODAY, NOW)!;
    expect(s.items[0].date).toBe(TODAY);
  });

  it("leaves out expected income and inactive subscriptions", () => {
    const s = upcomingSection([sub({ status: "cancelled" })], [detected({ avgAmount: 2500, payee: "Salary" })], [], TODAY, NOW)!;
    expect(s.items).toEqual([]);
  });

  it("keeps at most what the widget can hold", () => {
    const subs = Array.from({ length: 10 }, (_, i) => sub({ id: i + 1, name: `Bill ${i}`, nextDate: "2026-11-20" }));
    expect(upcomingSection(subs, [], [], TODAY, NOW)!.items).toHaveLength(MAX_UPCOMING_ITEMS);
  });

  it("a loan with no payment left in the window adds nothing", () => {
    const s = upcomingSection([], [], [{ loan: loan(), schedule: [{ date: "2026-01-15", payment: 566 }] }], TODAY, NOW)!;
    expect(s.items).toEqual([]);
  });

  it.each([
    ["an unreadable subscription name", [sub({ name: "v1:abc:def" })], [], []],
    ["a missing subscription name", [sub({ name: null })], [], []],
    ["an unreadable payee", [], [detected({ payee: "v1:abc:def" })], []],
    ["a missing loan name", [], [], [{ loan: loan({ name: null }), schedule: [] }]],
  ])("refuses %s, so the names it already has are kept", (_label, subs, recurring, loans) => {
    expect(upcomingSection(subs as SubscriptionRow[], recurring as RecurringRow[], loans as never, TODAY, NOW)).toBeNull();
  });

  it("does not look up a schedule for a paid-off loan or one that cannot be scheduled", () => {
    const active = loan({ id: 1 });
    const paidOff = loan({ id: 2, remainingBalance: 0, periodsRemaining: 0 });
    const broken = loan({ id: 3, remainingBalance: null, periodsRemaining: null, dataIntegrity: { error: "x", value: null } });
    expect(loansToSchedule([active, paidOff, broken]).map((l) => l.id)).toEqual([1]);
  });
});

describe("snapshot", () => {
  it("a section that could not be fetched keeps its figures and its old date", () => {
    const previous = mergeSnapshot(
      null,
      {
        leftToSpend: leftToSpendSection({ month: "2026-11", currency: "CAD", summary: { plannedSpending: 100, spent: 10 } }, 1000),
        upcoming: { asOfMs: 1000, items: [] },
        netWorth: netWorthSection({ displayCurrency: "CAD", netWorth: 5, totalAssets: 6, totalLiabilities: 1 }, 1000),
      },
      1000,
    );
    const next = netWorthSection({ displayCurrency: "CAD", netWorth: 9, totalAssets: 10, totalLiabilities: 1 }, 2000);
    const merged = mergeSnapshot(previous, { leftToSpend: null, upcoming: null, netWorth: next }, 2000);
    expect(merged.leftToSpend?.asOfMs).toBe(1000);
    expect(merged.upcoming?.asOfMs).toBe(1000);
    expect(merged.netWorth).toEqual(next);
    expect(merged.updatedAtMs).toBe(2000);
  });

  it("ignores a snapshot it cannot read or from another version", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("{not json")).toBeNull();
    expect(parseSnapshot(JSON.stringify({ version: WIDGET_SNAPSHOT_VERSION + 1 }))).toBeNull();
  });

  it("matches the sample the native render check draws", () => {
    const samplePath = path.join(__dirname, "../../modules/finlynq-widgets/android/src/debug/assets/widget-snapshot.sample.json");
    const sample = JSON.parse(fs.readFileSync(samplePath, "utf8")) as WidgetSnapshot;
    const built = mergeSnapshot(
      null,
      {
        leftToSpend: leftToSpendSection({ month: "2026-11", currency: "CAD", summary: { plannedSpending: 3000, spent: 1715.5 } }, NOW),
        upcoming: upcomingSection([sub()], [], [], TODAY, NOW),
        netWorth: netWorthSection({ displayCurrency: "CAD", netWorth: 1, totalAssets: 2, totalLiabilities: 1 }, NOW),
      },
      NOW,
    );
    expect(sample.version).toBe(built.version);
    expect(Object.keys(sample).sort()).toEqual(Object.keys(built).sort());
    expect(Object.keys(sample.leftToSpend!).sort()).toEqual(Object.keys(built.leftToSpend!).sort());
    expect(Object.keys(sample.upcoming!.items[0]).sort()).toEqual(Object.keys(built.upcoming!.items[0]).sort());
    expect(Object.keys(sample.netWorth!).sort()).toEqual(Object.keys(built.netWorth!).sort());
  });
});

describe("the native side", () => {
  const androidDir = path.join(__dirname, "../../modules/finlynq-widgets/android/src/main");
  const renderer = fs.readFileSync(path.join(androidDir, "java/com/finlynq/widgets/WidgetRenderer.kt"), "utf8");
  const providers = fs.readFileSync(path.join(androidDir, "java/com/finlynq/widgets/WidgetProviders.kt"), "utf8");
  const manifest = fs.readFileSync(path.join(androidDir, "AndroidManifest.xml"), "utf8");

  it("only opens links the app knows", () => {
    const links = [...renderer.matchAll(/"(pf-mobile:\/\/[a-z-]+)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(widgetLinkTarget(link)).not.toBeNull();
  });

  it("reads the snapshot's real field names", () => {
    const built = upcomingSection([sub()], [], [], TODAY, NOW)!;
    const known = new Set([
      ...Object.keys(mergeSnapshot(null, { leftToSpend: null, upcoming: null, netWorth: null }, NOW)),
      ...Object.keys(built),
      ...Object.keys(built.items[0]),
      ...Object.keys(leftToSpendSection({ month: "2026-11", currency: "CAD", summary: { plannedSpending: 1, spent: 0 } }, NOW)),
      ...Object.keys(netWorthSection({ displayCurrency: "CAD", netWorth: 1, totalAssets: 1, totalLiabilities: 0 }, NOW)),
    ]);
    const read = [...renderer.matchAll(/\.opt(?:String|Boolean|Double|Long|JSONObject|JSONArray)\("([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(8);
    for (const field of read) expect(known.has(field)).toBe(true);
  });

  it("declares every provider in the manifest", () => {
    const classes = [...providers.matchAll(/^class (\w+WidgetProvider)/gm)].map((m) => m[1]);
    expect(classes).toHaveLength(4);
    for (const name of classes) expect(manifest).toContain(`com.finlynq.widgets.${name}`);
  });

  it("never sends the app's data out of the sandbox", () => {
    expect(fs.readFileSync(path.join(androidDir, "java/com/finlynq/widgets/WidgetStore.kt"), "utf8")).toContain("noBackupFilesDir");
    expect(manifest).not.toContain("android:exported=\"true\"");
    expect(manifest).not.toContain("uses-permission");
  });
});

describe("links from a widget", () => {
  it("opens each widget's screen", () => {
    expect(widgetLinkTarget(WIDGET_LINKS.home)).toEqual({ tab: "Home" });
    expect(widgetLinkTarget(WIDGET_LINKS.budgets)).toEqual({ tab: "More", screen: "Budgets" });
    expect(widgetLinkTarget(WIDGET_LINKS.loans)).toEqual({ tab: "More", screen: "Loans" });
    expect(widgetLinkTarget(WIDGET_LINKS.subscriptions)).toEqual({ tab: "More", screen: "Subscriptions" });
    expect(widgetLinkTarget(WIDGET_LINKS.addTransaction)).toEqual({ tab: "Transactions", screen: "AddTransaction" });
  });

  it.each([null, undefined, "", "pf-mobile://settings", "pf-mobile://budgets?x=1", "pf-mobile://constructor", "https://budgets"])(
    "ignores %s",
    (url) => {
      expect(widgetLinkTarget(url)).toBeNull();
    },
  );
});

describe("following a widget's link", () => {
  const mock = (fn: unknown) => fn as jest.Mock;
  let sendUrl: (event: { url: string }) => void = () => {};

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigationRef.isReady.mockReturnValue(true);
    mockNavigationRef.getRootState.mockReturnValue({ routeNames: ["Home", "More", "Transactions"] });
    mock(Linking.getInitialURL).mockResolvedValue(null);
    mock(Linking.addEventListener).mockImplementation((_type: string, handler: (event: { url: string }) => void) => {
      sendUrl = handler;
      return { remove: jest.fn() };
    });
  });

  it("opens the screen at once when the app is unlocked", async () => {
    renderHook(() => useWidgetLinks(true));
    await act(async () => {});
    act(() => sendUrl({ url: WIDGET_LINKS.budgets }));
    expect(mockNavigationRef.navigate).toHaveBeenCalledWith("More", { screen: "Budgets", initial: false });
  });

  it("opens a tab that has no inner screen", async () => {
    renderHook(() => useWidgetLinks(true));
    await act(async () => {});
    act(() => sendUrl({ url: WIDGET_LINKS.home }));
    expect(mockNavigationRef.navigate).toHaveBeenCalledWith("Home");
  });

  it("waits for an unlock when tapped while locked, then opens it once", async () => {
    const { rerender } = renderHook(({ unlocked }: { unlocked: boolean }) => useWidgetLinks(unlocked), { initialProps: { unlocked: false } });
    await act(async () => {});
    act(() => sendUrl({ url: WIDGET_LINKS.addTransaction }));
    expect(mockNavigationRef.navigate).not.toHaveBeenCalled();
    jest.useFakeTimers();
    rerender({ unlocked: true });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    jest.useRealTimers();
    expect(mockNavigationRef.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigationRef.navigate).toHaveBeenCalledWith("Transactions", { screen: "AddTransaction", initial: false });
  });

  it("follows the link that launched the app", async () => {
    mock(Linking.getInitialURL).mockResolvedValue(WIDGET_LINKS.subscriptions);
    renderHook(() => useWidgetLinks(true));
    await act(async () => {});
    expect(mockNavigationRef.navigate).toHaveBeenCalledWith("More", { screen: "Subscriptions", initial: false });
  });

  it("holds the link until the tabs have mounted", async () => {
    mockNavigationRef.getRootState.mockReturnValue(undefined);
    const { result } = renderHook(() => useWidgetLinks(true));
    await act(async () => {});
    act(() => sendUrl({ url: WIDGET_LINKS.loans }));
    expect(mockNavigationRef.navigate).not.toHaveBeenCalled();
    mockNavigationRef.getRootState.mockReturnValue({ routeNames: ["Home", "More", "Transactions"] });
    act(() => result.current.onNavigationChange());
    expect(mockNavigationRef.navigate).toHaveBeenCalledWith("More", { screen: "Loans", initial: false });
  });

  it("ignores a link it does not know", async () => {
    renderHook(() => useWidgetLinks(true));
    await act(async () => {});
    act(() => sendUrl({ url: "pf-mobile://settings" }));
    expect(mockNavigationRef.navigate).not.toHaveBeenCalled();
  });
});

describe("refreshing the snapshot", () => {
  const mock = (fn: unknown) => fn as jest.Mock;

  function serverOk() {
    mock(getSession).mockResolvedValue({ authenticated: true, encryptionLocked: false });
    mock(endpoints.getBudgetMonth).mockResolvedValue({
      success: true,
      data: { month: "2026-11", currency: "CAD", summary: { plannedSpending: 3000, spent: 1000 } },
    });
    mock(endpoints.getSubscriptions).mockResolvedValue({ success: true, data: [sub({ nextDate: "2099-01-01" })] });
    mock(endpoints.getRecurring).mockResolvedValue({ success: true, data: { recurring: [] } });
    mock(endpoints.getLoans).mockResolvedValue({ success: true, data: [] });
    mock(endpoints.getDashboard).mockResolvedValue({
      success: true,
      data: { displayCurrency: "CAD", netWorth: 5, totalAssets: 6, totalLiabilities: 1 },
    });
  }

  function written(): WidgetSnapshot {
    const calls = mock(native.writeSnapshot).mock.calls;
    return JSON.parse(calls[calls.length - 1][0]);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetWidgetSyncForTests();
    mock(native.hasSnapshotReaders).mockReturnValue(true);
    mock(native.readSnapshot).mockReturnValue(null);
    serverOk();
  });

  it("does nothing, and stores nothing, until a widget showing figures is placed", async () => {
    mock(native.hasSnapshotReaders).mockReturnValue(false);
    expect(await syncWidgets()).toBe("no-widgets");
    expect(getSession).not.toHaveBeenCalled();
    expect(native.writeSnapshot).not.toHaveBeenCalled();
  });

  it("writes the sections it could build", async () => {
    expect(await syncWidgets()).toBe("updated");
    expect(endpoints.getBudgetMonth).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}$/));
    const snap = written();
    expect(snap.leftToSpend?.leftLabel).toBe("C$2,000.00");
    expect(snap.netWorth?.netWorthLabel).toBe("C$5.00");
    expect(snap.upcoming?.items).toEqual([]);
  });

  it("looks up each open loan's next payment", async () => {
    mock(endpoints.getLoans).mockResolvedValue({ success: true, data: [loan({ id: 7 }), loan({ id: 8, remainingBalance: 0, periodsRemaining: 0 })] });
    mock(endpoints.getLoanSchedule).mockResolvedValue({
      success: true,
      data: { summary: { schedule: [{ date: "2099-01-15", payment: 566 }] } },
    });
    await syncWidgets();
    expect(endpoints.getLoanSchedule).toHaveBeenCalledTimes(1);
    expect(endpoints.getLoanSchedule).toHaveBeenCalledWith(7);
  });

  it("a loan whose schedule fails is left out, not the whole list", async () => {
    mock(endpoints.getLoans).mockResolvedValue({ success: true, data: [loan()] });
    mock(endpoints.getLoanSchedule).mockResolvedValue({ success: false, error: "HTTP 500" });
    expect(await syncWidgets()).toBe("updated");
    expect(written().upcoming?.items).toEqual([]);
  });

  it("keeps the last figures when the session has no encryption key", async () => {
    mock(getSession).mockResolvedValue({ authenticated: true, encryptionLocked: true });
    expect(await syncWidgets()).toBe("locked");
    expect(endpoints.getSubscriptions).not.toHaveBeenCalled();
    expect(native.writeSnapshot).not.toHaveBeenCalled();
  });

  it("keeps the last figures when signed out or offline", async () => {
    mock(getSession).mockResolvedValue({ authenticated: false });
    expect(await syncWidgets()).toBe("locked");
    mock(getSession).mockRejectedValue(new Error("offline"));
    expect(await syncWidgets()).toBe("failed");
    expect(native.writeSnapshot).not.toHaveBeenCalled();
  });

  it("keeps a section the server could not answer", async () => {
    const previous = mergeSnapshot(
      null,
      {
        leftToSpend: leftToSpendSection({ month: "2026-11", currency: "CAD", summary: { plannedSpending: 100, spent: 10 } }, 1000),
        upcoming: null,
        netWorth: null,
      },
      1000,
    );
    mock(native.readSnapshot).mockReturnValue(JSON.stringify(previous));
    mock(endpoints.getBudgetMonth).mockResolvedValue({ success: false, error: "HTTP 404" });
    expect(await syncWidgets()).toBe("updated");
    expect(written().leftToSpend?.leftLabel).toBe("C$90.00");
    expect(written().leftToSpend?.asOfMs).toBe(1000);
  });

  it("writes nothing when every section failed", async () => {
    mock(endpoints.getBudgetMonth).mockResolvedValue({ success: false, error: "x" });
    mock(endpoints.getSubscriptions).mockResolvedValue({ success: false, error: "x" });
    mock(endpoints.getDashboard).mockResolvedValue({ success: false, error: "x" });
    expect(await syncWidgets()).toBe("failed");
    expect(native.writeSnapshot).not.toHaveBeenCalled();
  });

  it("opening the app again soon after does not refetch, a saved change does", async () => {
    await syncWidgets();
    mock(native.readSnapshot).mockReturnValue(JSON.stringify(written()));
    expect(await syncWidgets()).toBe("throttled");
    expect(await syncWidgets({ force: true })).toBe("updated");
    expect(native.writeSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refetches once the interval has passed", async () => {
    const spy = jest.spyOn(Date, "now");
    spy.mockReturnValue(NOW);
    await syncWidgets();
    mock(native.readSnapshot).mockReturnValue(JSON.stringify(written()));
    spy.mockReturnValue(NOW + WIDGET_SYNC_MIN_INTERVAL_MS + 1);
    expect(await syncWidgets()).toBe("updated");
    spy.mockRestore();
  });

  it("a change saved during a refresh gets its own refresh afterwards", async () => {
    let release: (v: unknown) => void = () => {};
    mock(getSession).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const first = syncWidgets();
    const second = syncWidgets({ force: true });
    release({ authenticated: true, encryptionLocked: false });
    await Promise.all([first, second]);
    expect(native.writeSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("Widgets screen", () => {
  const theme: Theme = {
    mode: "light",
    colors: lightColors,
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
    fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
  };
  const mock = (fn: unknown) => fn as jest.Mock;
  const screen = () => (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <WidgetsScreen />
    </ThemeContext.Provider>
  );

  beforeEach(() => {
    jest.clearAllMocks();
    resetWidgetSyncForTests();
    mock(native.canPinWidgets).mockReturnValue(true);
    mock(native.pinWidget).mockReturnValue(true);
    mock(native.getHideAmounts).mockReturnValue(false);
    mock(native.hasSnapshotReaders).mockReturnValue(true);
    mock(native.readSnapshot).mockReturnValue(null);
  });

  it("adds a widget through the launcher's prompt", () => {
    const { getByLabelText } = render(screen());
    fireEvent.press(getByLabelText("Add Left to spend to home screen"));
    expect(native.pinWidget).toHaveBeenCalledWith("leftToSpend");
  });

  it("explains how to add one when the launcher cannot be asked", () => {
    mock(native.canPinWidgets).mockReturnValue(false);
    const { getByText, queryByLabelText } = render(screen());
    expect(queryByLabelText("Add Left to spend to home screen")).toBeNull();
    expect(getByText(WIDGETS_HOW_TO_ADD)).toBeTruthy();
  });

  it("falls back to those steps when the launcher refuses", () => {
    mock(native.pinWidget).mockReturnValue(false);
    const { getByLabelText, getByText } = render(screen());
    fireEvent.press(getByLabelText("Add Net worth to home screen"));
    expect(getByText(WIDGETS_HOW_TO_ADD)).toBeTruthy();
  });

  it("hides amounts", () => {
    const { getByLabelText } = render(screen());
    fireEvent(getByLabelText("Hide amounts on widgets"), "valueChange", true);
    expect(native.setHideAmounts).toHaveBeenCalledWith(true);
  });

  it("shows the saved choice", () => {
    mock(native.getHideAmounts).mockReturnValue(true);
    const { getByLabelText } = render(screen());
    expect(getByLabelText("Hide amounts on widgets").props.value).toBe(true);
  });

  it("says when there is nothing to refresh yet", async () => {
    mock(native.hasSnapshotReaders).mockReturnValue(false);
    const { getByLabelText, findByText } = render(screen());
    await act(async () => {
      fireEvent.press(getByLabelText("Refresh widgets"));
    });
    expect(await findByText("Add a widget first: there is nothing to update yet.")).toBeTruthy();
  });

  it("says when the server cannot be reached", async () => {
    mock(getSession).mockRejectedValue(new Error("offline"));
    const { getByLabelText, findByText } = render(screen());
    await act(async () => {
      fireEvent.press(getByLabelText("Refresh widgets"));
    });
    expect(await findByText("Could not reach the server. Widgets keep showing the last figures.")).toBeTruthy();
  });

  it("shows when the figures were last updated", async () => {
    const snap = mergeSnapshot(null, { leftToSpend: null, upcoming: null, netWorth: null }, NOW);
    mock(native.readSnapshot).mockReturnValue(JSON.stringify(snap));
    const { queryByText } = render(screen());
    await waitFor(() => expect(queryByText("Not updated yet")).toBeNull());
  });
});
