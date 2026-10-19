/**
 * @vitest-environment jsdom
 *
 * Settings → Bank feeds must SHOW the problems a SimpleFIN sync reported
 * (in-app feedback 2026-10-18). The stored status only keeps a count, and the
 * banner told the user to "run a sync from this page to see the details" while
 * the page rendered neither the detect step's `errors` nor the sync's. Each
 * retry hit the same problems and wrote the same banner back, so from the
 * user's side "nothing happens".
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

import BankFeedsSettingsPage from "@/app/(app)/settings/bank-feeds/page";

const STATUS = {
  connected: true,
  lastSyncAt: "2026-10-18T16:35:52.000Z",
  lastSync: {
    ok: false,
    partial: true,
    trigger: "auto",
    at: "2026-10-18T16:35:52.000Z",
    message: "2 problems were reported during the sync.",
  },
};

const PREVIEW = {
  accounts: [
    {
      externalId: "ACT-1",
      name: "Chequing",
      currency: "USD",
      txCount: 5,
      status: "mapped",
      accountId: 1,
      accountName: "Chequing",
    },
  ],
  existingAccounts: [],
  errors: [
    "Connection to Bank Y may need attention",
    'Account "Chequing" tx TX-9: missing/invalid posted date',
  ],
};

const SYNC = {
  staged: [
    {
      stagedImportId: "s-1",
      accountId: 1,
      accountName: "Chequing",
      rowCount: 5,
      newCount: 0,
      duplicateCount: 5,
    },
  ],
  accountsCreated: 0,
  skippedNoChoice: [],
  skippedPending: 0,
  errors: [
    "Connection to Bank Y may need attention",
    'Account "Visa": could not be imported because of a server error.',
  ],
};

function mockApi() {
  const fetchMock = vi.fn(async (url: string) => {
    const body = url.endsWith("/status")
      ? STATUS
      : url.endsWith("/pending")
        ? { data: { pending: [] } }
        : url.endsWith("/preview")
          ? PREVIEW
          : url.endsWith("/sync")
            ? SYNC
            : {};
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Bank feeds page — sync problems", () => {
  it("points a 'finished with problems' banner at Sync now to see them", async () => {
    mockApi();
    render(<BankFeedsSettingsPage />);
    expect(await screen.findByText(/Automatic sync finished with problems/)).toBeTruthy();
    expect(screen.getByText(/2 problems were reported during the sync\./)).toBeTruthy();
    expect(screen.getByText(/to see what they were\./)).toBeTruthy();
  });

  it("lists the problems from the detect step and hides the count-only banner", async () => {
    mockApi();
    render(<BankFeedsSettingsPage />);
    await screen.findByText(/Automatic sync finished with problems/);

    fireEvent.click(screen.getAllByText("Sync now")[0]);

    expect(await screen.findByText("Connection to Bank Y may need attention")).toBeTruthy();
    expect(
      screen.getByText('Account "Chequing" tx TX-9: missing/invalid posted date'),
    ).toBeTruthy();
    expect(screen.getByText("2 problems were reported during this sync")).toBeTruthy();
    expect(screen.queryByText(/Automatic sync finished with problems/)).toBeNull();
  });

  it("lists the import's problems and says when nothing was new", async () => {
    const fetchMock = mockApi();
    render(<BankFeedsSettingsPage />);
    await screen.findByText(/Automatic sync finished with problems/);
    fireEvent.click(screen.getAllByText("Sync now")[0]);
    fireEvent.click(await screen.findByText("Import 5 to review"));

    expect(
      await screen.findByText('Account "Visa": could not be imported because of a server error.'),
    ).toBeTruthy();
    expect(screen.getByText("Nothing new to import")).toBeTruthy();
    expect(screen.getByText(/0 new transactions · 5 already in Finlynq/)).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/sync"))).toBe(true),
    );
    // The status reload after the import must not bring the banner back over the list.
    expect(screen.queryByText(/Automatic sync finished with problems/)).toBeNull();
  });
});
