/**
 * @vitest-environment jsdom
 *
 * The Lot inspector's "Edit allocation" editor (2026-10-14). It used to list
 * only lots still open, so a sale that used up its lot (the commonest
 * first-in-first-out case) kept those shares in the total with no field to
 * lower them, and Preview could never be enabled. It also offered lots bought
 * after the sale, which the server now refuses.
 *
 * Fixture = the demo's LOTTEST holding on dev: lot 2392 (100 @ 10, used up by
 * the sale on 2026-05-02), lot 2393 (100 @ 20, bought before) and lot 2394
 * (100 @ 30, bought a month after the sale).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

// base-ui's Dialog needs a portal jsdom doesn't render predictably; the
// editor is what's under test, so render the dialog's children inline.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement("div", null, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement("h2", null, children),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/components/portfolio/lot-allocation-matrix", () => ({ LotAllocationMatrix: () => null }));

import { LotInspectorDialog } from "@/components/portfolio/lot-inspector-dialog";

const lotRow = (over: Record<string, unknown>) => ({
  accountId: 1164,
  side: "long",
  origin: "buy",
  status: "open",
  qtyOriginal: 100,
  qtyRemaining: 100,
  currency: "USD",
  ...over,
});

const LOTS = [
  lotRow({ id: 2392, openTxId: 1, openDate: "2026-03-02", costPerShare: 10, status: "closed", qtyRemaining: 0 }),
  lotRow({ id: 2393, openTxId: 2, openDate: "2026-04-02", costPerShare: 20 }),
  lotRow({ id: 2394, openTxId: 3, openDate: "2026-06-02", costPerShare: 30 }),
];
const CLOSURES = [
  {
    id: 1,
    lotId: 2392,
    closeTxId: 89373,
    closeDate: "2026-05-02",
    qtyClosed: 100,
    proceedsPerShare: 25,
    costPerShare: 10,
    realizedGain: 1500,
    currency: "USD",
    closeKind: "sell",
    openAfterClose: false,
  },
];

function mockFetch() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return {
        ok: true,
        json: async () => ({
          preview: {
            proposedClosures: [{ lotId: 2393, qtyClosed: 100, realizedGain: 500, isNewShortLot: false }],
            openedShortLots: [],
            realizedGainDeltaByYear: { "2026": -1000 },
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ lots: LOTS, closures: CLOSURES }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openEditor() {
  const fetchMock = mockFetch();
  render(
    <LotInspectorDialog open onOpenChange={() => {}} holdingId={1071} accountId={1164} holdingName="LOTTEST" />,
  );
  fireEvent.click(await screen.findByText("Edit allocation"));
  return fetchMock;
}

describe("LotInspectorDialog — re-matching a sale", () => {
  it("lists the used-up lot with a field, plus the earlier lot, but not the later one", async () => {
    await openEditor();
    const usedUp = screen.getByTestId("reassign-lot-2392");
    expect(within(usedUp).getByLabelText("Shares from lot #2392")).toHaveProperty("value", "100");
    expect(usedUp.textContent).toContain("this sale takes 100 now");
    expect(screen.getByTestId("reassign-lot-2393")).toBeTruthy();
    expect(screen.queryByTestId("reassign-lot-2394")).toBeNull();
  });

  it("moving the shares to the earlier lot enables Preview and sends only that lot", async () => {
    const fetchMock = await openEditor();
    const preview = screen.getByText("Preview").closest("button")!;
    expect(preview.disabled).toBe(false); // the untouched allocation already adds up

    fireEvent.change(screen.getByLabelText("Shares from lot #2393"), { target: { value: "100" } });
    expect(preview.disabled).toBe(true); // 200 / 100: too many

    fireEvent.change(screen.getByLabelText("Shares from lot #2392"), { target: { value: "0" } });
    expect(preview.disabled).toBe(false); // the bug: this field didn't exist, so it stayed disabled

    fireEvent.click(preview);
    expect(await screen.findByText(/Restates realized gain/)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
      closeTxId: 89373,
      perLotQty: [{ lotId: 2393, qty: 100 }],
      preview: true,
    });
  });
});

// ─── A sale that sold more than was held (2026-10-14) ───────────────────────
// SHORTTEST shape: lot 2395 (100 @ 10) used up by sale 89379, which sold 150;
// the other 50 opened short lot 2397 (opened BY the sale). The total is the
// whole sale, and the short part has its own "Sold short" row (sent as lot 0).

function shortFixture(shortRemaining: number) {
  return {
    lots: [
      lotRow({ id: 2395, openTxId: 89377, openDate: "2026-03-02", costPerShare: 10, status: "closed", qtyRemaining: 0 }),
      lotRow({
        id: 2397, openTxId: 89379, openDate: "2026-05-02", side: "short", costPerShare: 25,
        qtyOriginal: 50, qtyRemaining: shortRemaining, status: shortRemaining > 0 ? "open" : "closed",
      }),
    ],
    closures: [
      { ...CLOSURES[0], id: 9, lotId: 2395, closeTxId: 89379, closeDate: "2026-05-02", realizedGain: 1500 },
      ...(shortRemaining < 50
        ? [{ ...CLOSURES[0], id: 10, lotId: 2397, closeTxId: 89381, closeDate: "2026-06-02", qtyClosed: 50 - shortRemaining, closeKind: "short_close", realizedGain: 500 }]
        : []),
    ],
  };
}

async function openShortEditor(shortRemaining: number) {
  const data = shortFixture(shortRemaining);
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? {
          ok: true,
          json: async () => ({
            preview: { proposedClosures: [], openedShortLots: [{ qty: 50, currency: "USD" }], realizedGainDeltaByYear: {} },
          }),
        }
      : { ok: true, json: async () => data },
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<LotInspectorDialog open onOpenChange={() => {}} holdingId={1072} accountId={1164} holdingName="SHORTTEST" />);
  fireEvent.click((await screen.findAllByText("Edit allocation"))[0]);
  return fetchMock;
}

describe("LotInspectorDialog — a sale that sold short", () => {
  it("counts the short in the total and sends it as lot 0, so saving keeps it", async () => {
    const fetchMock = await openShortEditor(50);
    expect(screen.getByText("150 / 150 sh")).toBeTruthy();
    expect(screen.getByLabelText("Shares sold short")).toHaveProperty("value", "50");
    const preview = screen.getByText("Preview").closest("button")!;
    expect(preview.disabled).toBe(false);

    fireEvent.click(preview);
    expect(await screen.findByText(/Opens 1 short lot/)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post![1] as RequestInit).body)).perLotQty).toEqual([
      { lotId: 0, qty: 50 },
      { lotId: 2395, qty: 100 },
    ]);
  });

  it("says why, and offers nothing to save, once a later buy closed part of the short", async () => {
    await openShortEditor(20);
    expect(screen.getByText(/a later purchase has already closed 30 of them/)).toBeTruthy();
    expect(screen.queryByLabelText("Shares sold short")).toBeNull();
    expect(screen.getByText("Preview").closest("button")!.disabled).toBe(true);
    expect(screen.getByText("Reassign").closest("button")!.disabled).toBe(true);
  });
});
