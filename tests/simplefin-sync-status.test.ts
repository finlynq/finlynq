/**
 * SimpleFIN sync outcome → stored status + auto-sync retry policy (PR #346
 * follow-up). The status is persisted in PLAINTEXT settings, so the leak
 * assertions (no account names, no response bodies, no credentials) are the
 * load-bearing half of this suite.
 */
import { describe, it, expect } from "vitest";
import { simplefin } from "@finlynq/import-connectors";
import {
  AUTO_SYNC_MIN_INTERVAL_MS,
  AUTO_SYNC_RETRY_BACKOFF_MS,
  accountProblemMessage,
  parseSyncStatus,
  retryStampIso,
  summarizeSimplefinSyncOutcome,
} from "@/lib/external-import/simplefin-sync-status";

const now = new Date("2026-09-13T12:00:00.000Z");

describe("summarizeSimplefinSyncOutcome", () => {
  it("records a clean sync as ok and keeps the throttle", () => {
    const r = summarizeSimplefinSyncOutcome({ result: { errors: [] } }, "auto", now);
    expect(r.status).toEqual({ ok: true, partial: false, trigger: "auto", at: now.toISOString() });
    expect(r.retrySooner).toBe(false);
  });

  it("flags per-account problems as partial without storing the account name", () => {
    const r = summarizeSimplefinSyncOutcome(
      { result: { errors: ['Account "Joint Chequing 4411": duplicate key', "Bank of Nowhere needs attention"] } },
      "manual",
      now,
    );
    expect(r.status.ok).toBe(false);
    expect(r.status.partial).toBe(true);
    expect(r.status.trigger).toBe("manual");
    expect(r.status.message).toBe("2 problems were reported during the sync.");
    expect(r.status.message).not.toMatch(/Chequing|4411|Nowhere/);
    expect(r.retrySooner).toBe(false);
  });

  it("words a single problem in the singular", () => {
    const r = summarizeSimplefinSyncOutcome({ result: { errors: ["x"] } }, "auto", now);
    expect(r.status.message).toBe("1 problem was reported during the sync.");
  });

  it("retries a transient API failure sooner and drops the response body", () => {
    const err = new simplefin.SimpleFinApiError(
      "SimpleFIN /accounts failed (HTTP 500): upstream detail for Joint Chequing",
      500,
    );
    const r = summarizeSimplefinSyncOutcome({ error: err }, "auto", now);
    expect(r.status).toMatchObject({ ok: false, partial: false });
    expect(r.status.message).toBe("SimpleFIN returned an error (HTTP 500).");
    expect(r.retrySooner).toBe(true);
  });

  it("retries a timeout sooner", () => {
    const err = new simplefin.SimpleFinApiError("timeout", 504);
    expect(summarizeSimplefinSyncOutcome({ error: err }, "auto", now).retrySooner).toBe(true);
  });

  it.each([401, 403, 0])("does not retry sooner when the connection itself is bad (HTTP %i)", (code) => {
    const err = new simplefin.SimpleFinApiError("rejected", code);
    const r = summarizeSimplefinSyncOutcome({ error: err }, "auto", now);
    expect(r.retrySooner).toBe(false);
    expect(r.status.message).toMatch(/Reconnect the bank feed/);
  });

  it("does not retry sooner when not connected", () => {
    const err = new Error("SimpleFIN is not connected");
    err.name = "SimplefinNotConnectedError";
    expect(summarizeSimplefinSyncOutcome({ error: err }, "auto", now).retrySooner).toBe(false);
  });

  it("stores a generic message for unknown errors (never the raw text)", () => {
    const err = new TypeError("fetch failed: https://user:secret@bridge.simplefin.org/accounts");
    const r = summarizeSimplefinSyncOutcome({ error: err }, "auto", now);
    expect(r.status.message).toBe("The sync failed before any account was processed.");
    expect(JSON.stringify(r.status)).not.toMatch(/secret|bridge/);
    expect(r.retrySooner).toBe(true);
  });
});

describe("retryStampIso", () => {
  it("re-opens the 12h throttle exactly when the backoff elapses", () => {
    const stamp = Date.parse(retryStampIso(now));
    const blocked = (at: number) => at - stamp < AUTO_SYNC_MIN_INTERVAL_MS;
    expect(blocked(now.getTime())).toBe(true);
    expect(blocked(now.getTime() + AUTO_SYNC_RETRY_BACKOFF_MS - 1)).toBe(true);
    expect(blocked(now.getTime() + AUTO_SYNC_RETRY_BACKOFF_MS)).toBe(false);
  });
});

describe("parseSyncStatus", () => {
  it.each([null, undefined, "", "not json", "null", "{}", '{"ok":"yes","at":"x"}'])(
    "reads %j as no status",
    (raw) => {
      expect(parseSyncStatus(raw as string | null | undefined)).toBeNull();
    },
  );

  it("drops the old 'run a sync to see the details' sentence from stored statuses", () => {
    // Stored before 2026-10-18; the page now adds its own call to action.
    const raw = JSON.stringify({
      ok: false,
      partial: true,
      trigger: "auto",
      at: "2026-10-18T16:35:52.000Z",
      message: "2 problems reported during the sync. Run a sync from this page to see the details.",
    });
    expect(parseSyncStatus(raw)?.message).toBe("2 problems reported during the sync.");
  });

  it("round-trips a stored status and defaults missing fields", () => {
    expect(parseSyncStatus('{"ok":false,"at":"2026-09-13T12:00:00.000Z","message":"m"}')).toEqual({
      ok: false,
      partial: false,
      trigger: "auto",
      at: "2026-09-13T12:00:00.000Z",
      message: "m",
    });
  });
});

describe("accountProblemMessage", () => {
  it("names the account and keeps a short, readable error", () => {
    expect(accountProblemMessage("Visa", new Error("Statement currency is missing"))).toBe(
      'Account "Visa": Statement currency is missing',
    );
  });

  it("replaces a raw database error, which carries the SQL and its parameters", () => {
    const err = new Error(
      'Failed query: insert into "staged_imports" ("id") values ($1)\nparams: v1:abc:def',
    );
    const msg = accountProblemMessage("Visa", err);
    expect(msg).toBe('Account "Visa": could not be imported because of a server error.');
    expect(msg).not.toMatch(/insert|params|v1:/);
  });

  it("replaces an overly long or missing message", () => {
    expect(accountProblemMessage("Visa", new Error("x".repeat(201)))).toMatch(/server error/);
    expect(accountProblemMessage("Visa", "not an error")).toMatch(/server error/);
  });
});
