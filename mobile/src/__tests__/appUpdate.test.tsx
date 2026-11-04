import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { AppState, Linking, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { UpdateBanner } from "../components/UpdateBanner";
import { appStoreUpdate, checkForUpdate, isNewerVersion } from "../lib/app-update";
import { availableVersionCode } from "../../modules/finlynq-app-update";
import { ThemeContext } from "../theme";
import type { Theme } from "../theme";
import { lightColors } from "../theme/colors";

const mockPlay = availableVersionCode as jest.Mock;
const mockOpen = Linking.openURL as jest.Mock;
const mockFetch = jest.fn();
const stored = new Map<string, string>();

const theme: Theme = {
  mode: "light",
  colors: lightColors,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  borderRadius: { sm: 7, md: 10, lg: 12, xl: 17, full: 9999 },
  fontSize: { xs: 11, sm: 13, base: 15, lg: 17, xl: 20, "2xl": 24, "3xl": 30 },
};
const renderBanner = () =>
  render(
    <ThemeContext.Provider value={{ ...theme, preference: "system", setPreference: () => {} }}>
      <UpdateBanner />
    </ThemeContext.Provider>,
  );

function setPlatform(os: "android" | "ios", version: string | number = "18.0") {
  Object.assign(Platform, { OS: os, Version: version });
}

beforeEach(() => {
  jest.clearAllMocks();
  stored.clear();
  mockPlay.mockResolvedValue(null);
  mockOpen.mockResolvedValue(undefined);
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => stored.get(key) ?? null);
  (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
    stored.set(key, value);
  });
  global.fetch = mockFetch as unknown as typeof fetch;
  setPlatform("android", 34);
});

describe("isNewerVersion", () => {
  it("compares numbers, not text", () => {
    expect(isNewerVersion("1.0.10", "1.0.9")).toBe(true);
    expect(isNewerVersion("1.0.9", "1.0.10")).toBe(false);
    expect(isNewerVersion("2.0", "1.9.9")).toBe(true);
  });

  it("is false for the same version, however it is written", () => {
    expect(isNewerVersion("1.0.29", "1.0.29")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0")).toBe(false);
  });

  it("is never newer when either side can't be read", () => {
    expect(isNewerVersion("1.0.x", "1.0.1")).toBe(false);
    expect(isNewerVersion("1.0.2", "")).toBe(false);
  });
});

describe("appStoreUpdate", () => {
  const lookup = (version: string, minimumOsVersion = "15.1") => ({
    resultCount: 1,
    results: [{ version, minimumOsVersion }],
  });

  it("offers a newer store version, remembered against that version", () => {
    expect(appStoreUpdate(lookup("1.0.30"), "1.0.29", "18.0")).toMatchObject({ id: "ios-1.0.30" });
  });

  it("stays quiet on the same version, and on a TestFlight build ahead of the store", () => {
    expect(appStoreUpdate(lookup("1.0.29"), "1.0.29", "18.0")).toBeNull();
    expect(appStoreUpdate(lookup("1.0.27"), "1.0.29", "18.0")).toBeNull();
  });

  it("doesn't ask for an update this phone's iOS can't install", () => {
    expect(appStoreUpdate(lookup("1.0.30", "17.0"), "1.0.29", "16.7")).toBeNull();
  });

  it("stays quiet on an answer it can't read", () => {
    expect(appStoreUpdate({ resultCount: 0, results: [] }, "1.0.29", "18.0")).toBeNull();
    expect(appStoreUpdate(null, "1.0.29", "18.0")).toBeNull();
    expect(appStoreUpdate(lookup("1.0.30"), undefined, "18.0")).toBeNull();
  });
});

describe("checkForUpdate", () => {
  it("takes Android's answer from Play, and never calls the App Store", async () => {
    mockPlay.mockResolvedValue(39);
    expect(await checkForUpdate()).toMatchObject({ id: "android-39", storeName: "Google Play" });
    mockPlay.mockResolvedValue(null);
    expect(await checkForUpdate()).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("takes iOS's answer from the App Store lookup, against the installed version", async () => {
    setPlatform("ios");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ version: "1.0.2" }] }),
    });
    // expo-constants is mocked at 1.0.1 in jest.setup.js.
    expect(await checkForUpdate()).toMatchObject({ id: "ios-1.0.2", storeName: "the App Store" });
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it("treats a failed lookup as no update", async () => {
    setPlatform("ios");
    mockFetch.mockResolvedValue({ ok: false });
    expect(await checkForUpdate()).toBeNull();
  });
});

describe("UpdateBanner", () => {
  it("shows nothing when the store has nothing newer", async () => {
    const screen = renderBanner();
    await waitFor(() => expect(mockPlay).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText("Update available") === null).toBe(true);
  });

  it("asks, and Update opens Play", async () => {
    mockPlay.mockResolvedValue(39);
    const screen = renderBanner();
    await screen.findByText("Update available");
    screen.getByText("A new version of Finlynq is ready in Google Play.");
    fireEvent.press(screen.getByText("Update"));
    await waitFor(() => expect(mockOpen).toHaveBeenCalledWith("market://details?id=com.finlynq.mobile"));
  });

  it("falls back to the website when no app takes the market link", async () => {
    mockPlay.mockResolvedValue(39);
    mockOpen.mockRejectedValueOnce(new Error("no handler"));
    const screen = renderBanner();
    await screen.findByText("Update available");
    fireEvent.press(screen.getByText("Update"));
    await waitFor(() =>
      expect(mockOpen).toHaveBeenLastCalledWith(
        "https://play.google.com/store/apps/details?id=com.finlynq.mobile",
      ),
    );
  });

  it("Not now hides it, and it stays hidden on the next launch", async () => {
    mockPlay.mockResolvedValue(39);
    const first = renderBanner();
    await first.findByText("Update available");
    fireEvent.press(first.getByText("Not now"));
    await waitFor(() => expect(first.queryByText("Update available") === null).toBe(true));
    expect(stored.get("pf_update_dismissed")).toBe("android-39");
    first.unmount();

    const second = renderBanner();
    await waitFor(() => expect(mockPlay).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(second.queryByText("Update available") === null).toBe(true);
  });

  it("asks again when a newer release comes after a Not now", async () => {
    stored.set("pf_update_dismissed", "android-39");
    mockPlay.mockResolvedValue(40);
    const screen = renderBanner();
    await screen.findByText("Update available");
  });

  it("shows nothing and doesn't throw when the check fails", async () => {
    mockPlay.mockRejectedValue(new Error("Play exploded"));
    const screen = renderBanner();
    await waitFor(() => expect(mockPlay).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText("Update available") === null).toBe(true);
  });

  it("re-checks on returning to the app only after the wait", async () => {
    let now = 1_000_000_000;
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
    const onChange = jest.fn();
    (AppState.addEventListener as jest.Mock).mockImplementation((_event, handler) => {
      onChange.mockImplementation(handler);
      return { remove: jest.fn() };
    });
    renderBanner();
    await waitFor(() => expect(mockPlay).toHaveBeenCalledTimes(1));

    now += 60 * 60 * 1000;
    await act(async () => onChange("active"));
    expect(mockPlay).toHaveBeenCalledTimes(1);

    now += 12 * 60 * 60 * 1000;
    await act(async () => onChange("active"));
    expect(mockPlay).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });
});
