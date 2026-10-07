/**
 * @vitest-environment jsdom
 *
 * UnlockGate's "locked" state (in-app feedback 2026-10-07). A valid sign-in
 * whose data key has expired server-side used to render the app normally, and
 * every read came back as `v1:` ciphertext. The gate must stop at a sign-in
 * prompt instead, and must re-check when the user returns to the tab, since
 * that is how the key usually expires: a tab left open past the idle window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { isSafeNext } from "@/lib/auth/safe-redirect";

const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push }) }));

import { UnlockGate } from "@/components/unlock-gate";

function mockSession(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => ({ json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  replace.mockReset();
  push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("UnlockGate", () => {
  it("renders the app for an unlocked session", async () => {
    mockSession({ authenticated: true, encryptionLocked: false });
    render(<UnlockGate><p>app content</p></UnlockGate>);
    expect(await screen.findByText("app content")).toBeTruthy();
  });

  it("shows the locked prompt, not the app, when the data key is gone", async () => {
    mockSession({ authenticated: true, encryptionLocked: true });
    render(<UnlockGate><p>app content</p></UnlockGate>);
    expect(await screen.findByText("Session locked")).toBeTruthy();
    expect(screen.queryByText("app content")).toBeNull();
    // Never an automatic redirect: a login that can't restore the key would loop.
    expect(replace).not.toHaveBeenCalled();
  });

  it("'Sign in again' returns to the current page after login", async () => {
    window.history.replaceState(null, "", "/transactions?account=5");
    mockSession({ authenticated: true, encryptionLocked: true });
    render(<UnlockGate><p>app content</p></UnlockGate>);
    fireEvent.click(await screen.findByText("Sign in again"));
    const target = push.mock.calls[0][0] as string;
    const params = new URL(target, "http://x").searchParams;
    expect(params.get("locked")).toBe("1");
    expect(params.get("redirect")).toBe("/transactions?account=5");
    expect(isSafeNext(params.get("redirect"))).toBe(true);
  });

  it("re-checks on returning to the tab and locks a page that was open", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchMock = mockSession({ authenticated: true, encryptionLocked: false });
    render(<UnlockGate><p>app content</p></UnlockGate>);
    expect(await screen.findByText("app content")).toBeTruthy();

    // Two hours later the key has idled out of the server cache.
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    fetchMock.mockImplementation(async () => ({
      json: async () => ({ authenticated: true, encryptionLocked: true }),
    }));
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(screen.getByText("Session locked")).toBeTruthy());
    expect(screen.queryByText("app content")).toBeNull();
  });

  it("does not sign the user out when a re-check hits a network error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchMock = mockSession({ authenticated: true, encryptionLocked: false });
    render(<UnlockGate><p>app content</p></UnlockGate>);
    expect(await screen.findByText("app content")).toBeTruthy();

    vi.setSystemTime(Date.now() + 60_000);
    fetchMock.mockImplementation(async () => { throw new Error("offline"); });
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("app content")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("isSafeNext", () => {
  it.each(["/dashboard", "/transactions?account=5"])("accepts %s", (p) => {
    expect(isSafeNext(p)).toBe(true);
  });
  it.each([null, "", "dashboard", "//evil.example", "https://evil.example", "/\\evil.example"])(
    "rejects %j",
    (p) => expect(isSafeNext(p)).toBe(false),
  );
});
