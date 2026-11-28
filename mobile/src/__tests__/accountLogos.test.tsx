import React from "react";
import { render, waitFor, fireEvent } from "@testing-library/react-native";
import { Text } from "react-native";
import { endpoints } from "../api/client";
import {
  parseLogoVersions,
  loadLogoVersions,
  clearLogoVersions,
  accountLogoSource,
  LOGO_VERSIONS_TTL_MS,
} from "../lib/account-logos";
import { AccountLogo } from "../components/AccountLogo";

let mockToken: string | null = "tok123";

jest.mock("../api/client", () => ({
  endpoints: { getAccountLogoVersions: jest.fn() },
  getServerUrl: () => "https://finlynq.test",
  getAuthToken: () => mockToken,
}));

const getVersions = endpoints.getAccountLogoVersions as jest.Mock;

describe("parseLogoVersions", () => {
  it("keeps positive numeric versions under integer account ids", () => {
    expect(
      parseLogoVersions({ versions: { "12": 1732000000000, "7": 5, x: 3, "0": 9, "4": "no", "5": -1 } }),
    ).toEqual({ 12: 1732000000000, 7: 5 });
  });

  it("reads anything else as no logos", () => {
    expect(parseLogoVersions(null)).toEqual({});
    expect(parseLogoVersions({})).toEqual({});
    expect(parseLogoVersions({ versions: "x" })).toEqual({});
  });
});

describe("accountLogoSource", () => {
  afterEach(() => {
    mockToken = "tok123";
  });

  it("builds the versioned logo URL with the session's Bearer token", () => {
    expect(accountLogoSource(12, 99)).toEqual({
      uri: "https://finlynq.test/api/accounts/12/logo?v=99",
      headers: { Authorization: "Bearer tok123" },
    });
  });

  it("sends no header without a token (the cookie still signs the request)", () => {
    mockToken = null;
    expect(accountLogoSource(12, 99)).toEqual({ uri: "https://finlynq.test/api/accounts/12/logo?v=99" });
  });

  it("is null for an account with no logo", () => {
    expect(accountLogoSource(12, undefined)).toBeNull();
  });
});

describe("loadLogoVersions", () => {
  beforeEach(() => {
    clearLogoVersions();
    getVersions.mockReset();
  });

  it("asks once and reuses the answer for a minute", async () => {
    getVersions.mockResolvedValue({ success: true, data: { versions: { "3": 10 } } });
    const t0 = Date.now();
    expect(await loadLogoVersions(false, t0)).toEqual({ 3: 10 });
    expect(await loadLogoVersions(false, t0 + 1000)).toEqual({ 3: 10 });
    expect(getVersions).toHaveBeenCalledTimes(1);
    await loadLogoVersions(false, t0 + LOGO_VERSIONS_TTL_MS + 5000);
    expect(getVersions).toHaveBeenCalledTimes(2);
  });

  it("reads a failure or a server without the route as no logos, and retries next time", async () => {
    getVersions.mockResolvedValueOnce({ success: false, error: "HTTP 404" });
    expect(await loadLogoVersions()).toEqual({});
    getVersions.mockRejectedValueOnce(new Error("offline"));
    expect(await loadLogoVersions()).toEqual({});
    getVersions.mockResolvedValueOnce({ success: true, data: { versions: { "1": 2 } } });
    expect(await loadLogoVersions()).toEqual({ 1: 2 });
  });

  it("forgets the previous user's answer on sign-out", async () => {
    getVersions.mockResolvedValue({ success: true, data: { versions: { "3": 10 } } });
    await loadLogoVersions();
    clearLogoVersions();
    getVersions.mockResolvedValue({ success: true, data: { versions: {} } });
    expect(await loadLogoVersions()).toEqual({});
  });
});

describe("AccountLogo", () => {
  it("shows the logo image when the account has one", () => {
    const { getByTestId, queryByText, UNSAFE_getByType } = render(
      <AccountLogo accountId={5} version={42} size={36} fallback={<Text>icon</Text>} />,
    );
    expect(getByTestId("account-logo-5")).toBeTruthy();
    expect(queryByText("icon")).toBeNull();
    const img = UNSAFE_getByType("Image" as unknown as React.ComponentType);
    expect(img.props.source.uri).toBe("https://finlynq.test/api/accounts/5/logo?v=42");
  });

  it("keeps the usual icon when there is no logo", () => {
    const { getByText, queryByTestId } = render(
      <AccountLogo accountId={5} version={undefined} size={36} fallback={<Text>icon</Text>} />,
    );
    expect(getByText("icon")).toBeTruthy();
    expect(queryByTestId("account-logo-5")).toBeNull();
  });

  it("falls back to the icon when the image fails to load", async () => {
    const { getByText, UNSAFE_getByType } = render(
      <AccountLogo accountId={5} version={42} size={36} fallback={<Text>icon</Text>} />,
    );
    fireEvent(UNSAFE_getByType("Image" as unknown as React.ComponentType), "error");
    await waitFor(() => expect(getByText("icon")).toBeTruthy());
  });
});
