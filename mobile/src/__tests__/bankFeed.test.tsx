// Bank feed on mobile (in-app feedback 2026-10-30: the phone app could not
// sync SimpleFIN, so its bank data always lagged).
import React from "react";
import { render, waitFor, fireEvent, act } from "@testing-library/react-native";
import { Linking } from "react-native";
import BankFeedScreen from "../screens/BankFeedScreen";
import { endpoints } from "../api/client";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";
import {
  SIMPLEFIN_BRIDGE_URL,
  lastSyncLine,
  lastSyncProblemNote,
  lastSyncedAt,
  problemsHeading,
  summarizeSync,
  syncAccountLine,
  syncTimeLabel,
} from "../lib/bank-feed";
import type { SimplefinStagedResult, SimplefinStatus, SimplefinSyncResult } from "../../../shared/types";

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual("@react-navigation/native"),
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
}));

jest.mock("../api/client", () => ({
  endpoints: { getBankFeedStatus: jest.fn(), syncBankFeed: jest.fn() },
}));

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};

function screen() {
  return (
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <BankFeedScreen />
    </ThemeContext.Provider>
  );
}

const getStatus = endpoints.getBankFeedStatus as jest.Mock;
const syncFeed = endpoints.syncBankFeed as jest.Mock;
const ok = <T,>(data: T) => ({ success: true, data });

// Local times, so the labels hold in any time zone the tests run in.
const NOW = new Date(2026, 9, 30, 18, 0);
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).toISOString();

const staged = (over: Partial<SimplefinStagedResult> = {}): SimplefinStagedResult => ({
  stagedImportId: "imp-1",
  accountId: 7,
  accountName: "Chequing",
  rowCount: 5,
  newCount: 3,
  duplicateCount: 2,
  mode: "manual",
  stage: "pending",
  recorded: 0,
  sweptStaleRows: 0,
  ...over,
});

const result = (over: Partial<SimplefinSyncResult> = {}): SimplefinSyncResult => ({
  staged: [staged()],
  accountsCreated: 0,
  skippedNoChoice: [],
  skippedPending: 0,
  errors: [],
  ...over,
});

const connected = (over: Partial<SimplefinStatus> = {}): SimplefinStatus => ({
  connected: true,
  lastSyncAt: at(2026, 9, 30, 13, 17),
  lastSync: { ok: true, partial: false, trigger: "auto", at: at(2026, 9, 30, 13, 17) },
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("bank-feed wording", () => {
  it("labels a sync time in local time, relative to today", () => {
    expect(syncTimeLabel(at(2026, 9, 30, 17, 5), NOW)).toBe("today, 5:05 PM");
    expect(syncTimeLabel(at(2026, 9, 29, 0, 30), NOW)).toBe("yesterday, 12:30 AM");
    expect(syncTimeLabel(at(2026, 9, 2, 12, 0), NOW)).toBe("Oct 2, 12:00 PM");
    expect(syncTimeLabel(at(2025, 11, 31, 9, 2), NOW)).toBe("Dec 31, 2025, 9:02 AM");
    expect(syncTimeLabel("not a date", NOW)).toBe("not a date");
  });

  // A sync that found nothing new must still read as a sync, or the user who
  // just tapped Sync now sees yesterday's time.
  it("counts the last sync that ran, not only the last rows staged", () => {
    const s = connected({
      lastSyncAt: at(2026, 9, 29, 9, 0),
      lastSync: { ok: true, partial: false, trigger: "manual", at: at(2026, 9, 30, 17, 5) },
    });
    expect(lastSyncedAt(s)).toBe(at(2026, 9, 30, 17, 5));
    expect(lastSyncLine(s, NOW)).toBe("Last synced today, 5:05 PM");
    // A partial sync ran too; a failed one did not.
    expect(lastSyncedAt({ ...s, lastSync: { ...s.lastSync!, ok: false, partial: true } })).toBe(at(2026, 9, 30, 17, 5));
    expect(lastSyncedAt({ ...s, lastSync: { ...s.lastSync!, ok: false, partial: false } })).toBe(at(2026, 9, 29, 9, 0));
    expect(lastSyncLine({ connected: true, lastSyncAt: null, lastSync: null }, NOW)).toBe("Not synced yet");
  });

  it("explains a failed or partial last sync, like the web banner", () => {
    expect(lastSyncProblemNote(null, NOW)).toBeNull();
    expect(lastSyncProblemNote({ ok: true, partial: false, trigger: "auto", at: at(2026, 9, 30, 13, 17) }, NOW)).toBeNull();
    expect(
      lastSyncProblemNote(
        { ok: false, partial: true, trigger: "auto", at: at(2026, 9, 30, 13, 17), message: "1 problem was reported during the sync." },
        NOW,
      ),
    ).toBe(
      "The automatic sync finished with problems (today, 1:17 PM). 1 problem was reported during the sync. Sync now to see what they were.",
    );
    expect(
      lastSyncProblemNote({ ok: false, partial: false, trigger: "manual", at: at(2026, 9, 29, 8, 0) }, NOW),
    ).toBe("The last sync failed (yesterday, 8:00 AM). Sync now to try again.");
  });

  it("says where each account's new rows are waiting, by the account's mode", () => {
    // manual: the staged file waits for review.
    expect(syncAccountLine(staged())).toEqual({
      accountId: 7,
      accountName: "Chequing",
      text: "3 new transactions, waiting for your review · 2 already in Finlynq",
      target: { screen: "StagedImport", id: "imp-1", title: "Chequing", label: "Review" },
    });
    // approve: the rows are in the bank ledger.
    expect(syncAccountLine(staged({ mode: "approve", stage: "loaded", newCount: 1, duplicateCount: 0 }))).toMatchObject({
      text: "1 new transaction, ready to match in Reconcile",
      target: { screen: "Inbox", accountId: 7, label: "Reconcile" },
    });
    // auto: rules recorded some, the rest wait in Reconcile.
    expect(
      syncAccountLine(staged({ mode: "auto", stage: "recorded", newCount: 4, recorded: 3, duplicateCount: 0 })),
    ).toMatchObject({
      text: "4 new transactions: 3 recorded by your rules, 1 to categorize in Reconcile",
      target: { screen: "Inbox", accountId: 7 },
    });
    expect(
      syncAccountLine(staged({ mode: "auto", stage: "recorded", newCount: 2, recorded: 2, duplicateCount: 0, sweptStaleRows: 1 })),
    ).toMatchObject({ text: "2 new transactions, all recorded by your rules · 1 older row recorded by your rules", target: null });
    expect(syncAccountLine(staged({ newCount: 0, duplicateCount: 5 }))).toMatchObject({
      text: "Nothing new · 5 already in Finlynq",
      target: null,
    });
  });

  it("totals the sync and names bank accounts that are not linked yet", () => {
    const s = summarizeSync(
      result({
        staged: [staged(), staged({ accountId: 8, accountName: "Visa", newCount: 1, stage: "loaded", mode: "approve" })],
        skippedNoChoice: [{ externalId: "x1", name: "Savings" }],
        skippedPending: 2,
        errors: ["Bank of Somewhere: connection needs attention"],
      }),
    );
    expect(s.headline).toBe("4 new transactions from your bank");
    expect(s.accounts.map((a) => a.accountName)).toEqual(["Chequing", "Visa"]);
    expect(s.newAccounts).toBe(
      "1 bank account is not linked to Finlynq yet (Savings), so nothing was imported from it. " +
        "Link it on the web app, under Settings → Bank feeds, and it syncs from here after that.",
    );
    expect(s.pendingNote).toBe("2 pending charges are left out until the bank posts them.");
    expect(s.problems).toEqual(["Bank of Somewhere: connection needs attention"]);

    const none = summarizeSync(
      result({ staged: [], skippedNoChoice: [{ externalId: "a", name: "A" }, { externalId: "b", name: "B" }], skippedPending: 1 }),
    );
    expect(none.headline).toBe("Nothing new from your bank");
    expect(none.newAccounts).toMatch(/^2 bank accounts are not linked to Finlynq yet \(A, B\), so nothing was imported from them\. Link them /);
    expect(none.newAccounts).toMatch(/and they sync from here after that\.$/);
    expect(none.pendingNote).toBe("1 pending charge is left out until the bank posts it.");
  });

  // The response dev returned on 2026-10-30 for a scratch account linked to
  // SimpleFIN's developer demo, with one of its three accounts linked.
  it("reads a real sync response", () => {
    const real = {
      staged: [
        {
          stagedImportId: "ae923ed7-8305-40c9-9844-f5a6cc24fa13",
          accountId: 1186,
          accountName: "SimpleFIN Checking",
          rowCount: 169,
          newCount: 169,
          duplicateCount: 0,
          mode: "manual",
          stage: "pending",
          recorded: 0,
          sweptStaleRows: 0,
        },
      ],
      accountsCreated: 0,
      skippedNoChoice: [
        { externalId: "Demo Savings", name: "SimpleFIN Savings" },
        { externalId: "Demo Empty Account", name: "SimpleFIN Empty Account" },
      ],
      skippedPending: 0,
      errors: ["Requested date range exceeds limit of 90 days and was capped."],
    } as SimplefinSyncResult;
    const s = summarizeSync(real);
    expect(s.headline).toBe("169 new transactions from your bank");
    expect(s.accounts[0]).toMatchObject({
      text: "169 new transactions, waiting for your review",
      target: { screen: "StagedImport", id: "ae923ed7-8305-40c9-9844-f5a6cc24fa13", title: "SimpleFIN Checking" },
    });
    expect(s.newAccounts).toMatch(/^2 bank accounts are not linked to Finlynq yet \(SimpleFIN Savings, SimpleFIN Empty Account\)/);
    expect(s.pendingNote).toBeNull();
    expect(s.problems).toEqual(["Requested date range exceeds limit of 90 days and was capped."]);
  });

  it("heads the problem list with its count", () => {
    expect(problemsHeading(1)).toBe("1 problem was reported during this sync");
    expect(problemsHeading(3)).toBe("3 problems were reported during this sync");
  });

  // No em dashes in anything the user reads (owner rule for user-facing copy).
  it("writes no em dash", () => {
    const s = summarizeSync(
      result({ skippedNoChoice: [{ externalId: "x", name: "N" }], skippedPending: 3, errors: ["e"] }),
    );
    const texts = [
      s.headline,
      s.newAccounts,
      s.pendingNote,
      ...s.accounts.map((a) => a.text),
      lastSyncProblemNote({ ok: false, partial: true, trigger: "auto", at: at(2026, 9, 30, 1, 0), message: "m" }, NOW),
    ];
    for (const t of texts) expect(t ?? "").not.toContain("—");
  });
});

describe("BankFeedScreen", () => {
  it("points to the web when no feed is connected, with no sync button", async () => {
    getStatus.mockResolvedValue(ok({ connected: false, lastSyncAt: null, lastSync: null }));
    const { findByText, queryByLabelText } = render(screen());
    expect(await findByText(/No bank feed is connected\. Connect SimpleFIN on the web app/)).toBeTruthy();
    expect(queryByLabelText("Sync now")).toBeNull();
  });

  it("shows the last sync and the last sync's problem until a new sync runs", async () => {
    getStatus.mockResolvedValue(
      ok(
        connected({
          lastSync: { ok: false, partial: true, trigger: "auto", at: at(2026, 9, 30, 13, 17), message: "1 problem was reported during the sync." },
        }),
      ),
    );
    const { findByText, getByText } = render(screen());
    expect(await findByText(/^Last synced /)).toBeTruthy();
    expect(getByText(/The automatic sync finished with problems/)).toBeTruthy();
  });

  it("syncs, lists the problems and opens where each account's rows wait", async () => {
    getStatus.mockResolvedValue(ok(connected()));
    syncFeed.mockResolvedValue(
      ok(
        result({
          staged: [staged(), staged({ accountId: 8, accountName: "Visa", stage: "loaded", mode: "approve", newCount: 1 })],
          skippedNoChoice: [{ externalId: "x1", name: "Savings" }],
          errors: ["Bank of Somewhere: connection needs attention"],
        }),
      ),
    );
    const { findByLabelText, findByText, getByText, getByLabelText } = render(screen());
    fireEvent.press(await findByLabelText("Sync now"));

    expect(await findByText("4 new transactions from your bank")).toBeTruthy();
    expect(syncFeed).toHaveBeenCalledTimes(1);
    expect(getByText("1 problem was reported during this sync")).toBeTruthy();
    expect(getByText("• Bank of Somewhere: connection needs attention")).toBeTruthy();
    expect(getByText(/1 bank account is not linked to Finlynq yet \(Savings\)/)).toBeTruthy();
    // The status is reloaded so "Last synced" moves.
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));

    fireEvent.press(getByLabelText("Review Chequing"));
    expect(mockNavigate).toHaveBeenCalledWith("StagedImport", { id: "imp-1", title: "Chequing" });
    fireEvent.press(getByLabelText("Reconcile Visa"));
    expect(mockNavigate).toHaveBeenCalledWith("Inbox", { accountId: 8 });
    fireEvent.press(getByText("Open simplefin.org"));
    expect(Linking.openURL).toHaveBeenCalledWith(SIMPLEFIN_BRIDGE_URL);
  });

  // The sync route has no idempotency key; a double tap must not pull twice.
  it("runs one sync at a time", async () => {
    getStatus.mockResolvedValue(ok(connected()));
    let finish: (v: unknown) => void = () => {};
    syncFeed.mockReturnValue(new Promise((r) => (finish = r)));
    const { findByLabelText, findByText } = render(screen());
    const btn = await findByLabelText("Sync now");
    fireEvent.press(btn);
    fireEvent.press(btn);
    expect(await findByText("Syncing…")).toBeTruthy();
    expect(syncFeed).toHaveBeenCalledTimes(1);
    await act(async () => finish(ok(result({ staged: [] }))));
    expect(await findByText("Nothing new from your bank")).toBeTruthy();
  });

  it("says why a sync failed and keeps the screen usable", async () => {
    getStatus.mockResolvedValue(ok(connected()));
    syncFeed.mockResolvedValueOnce({ success: false, error: "SimpleFIN returned an error" });
    syncFeed.mockRejectedValueOnce(new Error("offline"));
    const { findByLabelText, findByText } = render(screen());
    fireEvent.press(await findByLabelText("Sync now"));
    expect(await findByText("SimpleFIN returned an error")).toBeTruthy();
    fireEvent.press(await findByLabelText("Sync now"));
    expect(await findByText("Could not reach the server. Try again in a moment.")).toBeTruthy();
  });

  it("offers a retry when the status can't be loaded", async () => {
    getStatus.mockResolvedValueOnce({ success: false, error: "HTTP 500" });
    getStatus.mockResolvedValueOnce(ok({ connected: false, lastSyncAt: null, lastSync: null }));
    const { findByText } = render(screen());
    expect(await findByText("HTTP 500")).toBeTruthy();
    fireEvent.press(await findByText("Try again"));
    expect(await findByText(/No bank feed is connected/)).toBeTruthy();
  });
});
