/**
 * @vitest-environment jsdom
 *
 * A waiting email that a rule matched shows why it is waiting, and can be
 * recorded with that rule in one click (owner report 2026-10-16). Before, a
 * rule-matched alert held as a possible duplicate looked like any other
 * waiting email: account and category empty, no mention of the rule, and
 * "Record anyway" only after picking both by hand.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/components/inbox/email-rule-dialog", () => ({ EmailRuleDialog: () => null }));

import { InboxEmailTab } from "@/components/inbox/inbox-email-tab";

const ITEM = {
  id: "e1",
  fromAddress: "alerts@bank.example",
  subject: "Recurring payment alert",
  receivedAt: "2026-10-13T12:00:00Z",
  nextPurgeAt: null,
  action: "needs_review",
  sourceKind: "body",
  parseConfidence: "high",
  matchedRuleId: 22,
  recordedTransactionId: null,
  stagedImportId: "s-1",
  candidate: { date: "2026-10-13", amount: -15.81, currency: "USD", payee: "Spotify P47F54492B" },
};

function detail(heldByRule: unknown) {
  return {
    id: "e1",
    fromAddress: ITEM.fromAddress,
    subject: ITEM.subject,
    bodyText: "A recurring payment of $15.81 on Oct 13, 2026. Details: Spotify P47F54492B.",
    bodyHtml: null,
    receivedAt: ITEM.receivedAt,
    action: "needs_review",
    sourceKind: "body",
    candidate: { date: "2026-10-13", amount: -15.81, currency: "USD", payee: "Spotify P47F54492B" },
    signals: null,
    heldByRule,
  };
}

function mockApi(heldByRule: unknown) {
  const patches: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      return ok({ ok: true, action: "manually_recorded", transactionId: 999 });
    }
    if (url === "/api/import/email-inbox") return ok([ITEM]);
    if (url === "/api/import/email-inbox/e1") return ok(detail(heldByRule));
    if (url === "/api/accounts") return ok([{ id: 635, name: "Rogers MC", currency: "CAD" }]);
    if (url === "/api/categories") return ok([]);
    return ok({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return patches;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HOLD = {
  ruleId: 22,
  ruleName: "Spotify",
  mode: "auto",
  accountId: 635,
  canRecord: true,
  duplicate: { transactionId: 250879, date: "2026-10-09", amount: -15.81, payee: "Amazon Marketplace" },
};

describe("Email tab — a waiting email a rule matched", () => {
  it("marks the row, names the transaction it is held against, and records anyway with the rule", async () => {
    const patches = mockApi(HOLD);
    render(<InboxEmailTab />);
    expect(await screen.findByText("rule matched")).toBeTruthy();

    fireEvent.click(screen.getByText("Recurring payment alert"));
    const link = await screen.findByRole("link", { name: /Amazon Marketplace/ });
    expect(link.getAttribute("href")).toBe("/transactions?id=250879");
    expect(screen.getByText(/Rule .Spotify. matched, but this wasn.t recorded/)).toBeTruthy();

    fireEvent.click(screen.getByText("Record anyway"));
    await waitFor(() => expect(patches).toEqual([{ action: "record_rule", force: true }]));
  });

  it("offers 'Record with this rule' when the rule waits for a click", async () => {
    const patches = mockApi({ ...HOLD, mode: "review", duplicate: null });
    render(<InboxEmailTab />);
    fireEvent.click(await screen.findByText("Recurring payment alert"));
    expect(await screen.findByText(/set to wait for your click/)).toBeTruthy();

    fireEvent.click(screen.getByText("Record with this rule"));
    await waitFor(() => expect(patches).toEqual([{ action: "record_rule", force: false }]));
  });

  it("has no one-click record for a rule without a category", async () => {
    mockApi({ ...HOLD, canRecord: false, duplicate: null });
    render(<InboxEmailTab />);
    fireEvent.click(await screen.findByText("Recurring payment alert"));
    expect(await screen.findByText(/has no category/)).toBeTruthy();
    expect(screen.queryByText("Record with this rule")).toBeNull();
    expect(screen.queryByText("Record anyway")).toBeNull();
  });
});
