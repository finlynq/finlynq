// Is a newer release waiting in the store? Mobile ships only through store releases
// (no OTA), so this is how someone with auto-update turned off finds out.
//
// Both answers come from the store, not from a version we publish ourselves, so
// there is nothing to bump on a release and a build still in review never prompts.
import { Platform } from "react-native";
import Constants from "expo-constants";
import { availableVersionCode } from "../../modules/finlynq-app-update";

const PLAY_APP_URL = "market://details?id=com.finlynq.mobile";
const PLAY_WEB_URL = "https://play.google.com/store/apps/details?id=com.finlynq.mobile";
const APP_STORE_URL = "https://apps.apple.com/app/id6775981169";
const APP_STORE_LOOKUP_URL = "https://itunes.apple.com/lookup?bundleId=com.finlynq.mobile";

export interface AvailableUpdate {
  /** What "Not now" is remembered against, so the next release asks again. */
  id: string;
  storeName: string;
  /** Tried in order: a phone may have no Play Store app to take `market://`. */
  urls: string[];
}

/** Numeric, so 1.0.10 is newer than 1.0.9. Anything unparseable is never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** The App Store's lookup answer, read against this install and this phone's iOS. */
export function appStoreUpdate(
  lookup: unknown,
  currentVersion: string | undefined,
  osVersion: string,
): AvailableUpdate | null {
  const result = (lookup as { results?: { version?: unknown; minimumOsVersion?: unknown }[] })
    ?.results?.[0];
  if (!currentVersion || typeof result?.version !== "string") return null;
  if (!isNewerVersion(result.version, currentVersion)) return null;
  // Don't ask for an update this phone can't install.
  if (typeof result.minimumOsVersion === "string" && isNewerVersion(result.minimumOsVersion, osVersion)) {
    return null;
  }
  return { id: `ios-${result.version}`, storeName: "the App Store", urls: [APP_STORE_URL] };
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (Platform.OS === "android") {
    const versionCode = await availableVersionCode();
    if (versionCode == null) return null;
    return {
      id: `android-${versionCode}`,
      storeName: "Google Play",
      urls: [PLAY_APP_URL, PLAY_WEB_URL],
    };
  }
  if (Platform.OS === "ios") {
    const response = await fetch(APP_STORE_LOOKUP_URL);
    if (!response.ok) return null;
    return appStoreUpdate(await response.json(), Constants.expoConfig?.version, String(Platform.Version));
  }
  return null;
}
