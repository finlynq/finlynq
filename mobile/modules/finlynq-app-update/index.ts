// Google Play's in-app update check. Android only: iOS has no equivalent, so
// lib/app-update.ts asks the App Store's public lookup there instead.
import { requireOptionalNativeModule } from "expo";

interface FinlynqAppUpdateNative {
  availableVersionCode(): Promise<number | null>;
}

const native = requireOptionalNativeModule<FinlynqAppUpdateNative>("FinlynqAppUpdate");

/** The versionCode Play would update this install to, or null for none or unknown. */
export async function availableVersionCode(): Promise<number | null> {
  return (await native?.availableVersionCode()) ?? null;
}
