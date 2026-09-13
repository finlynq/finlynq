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
    expect(r.status.message).toMatch(/^2 problems reported/);
    expect(r.status.message).not.toMatch(/Chequing|4411|Nowhere/);
    expect(r.retrySooner).toBe(false);
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
