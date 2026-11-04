// Home-screen widgets (GH #392). Everything here is a safe no-op in a build
// without the native module, such as an old store build updated over the air.
import { requireOptionalNativeModule } from "expo";

export type WidgetKindKey = "leftToSpend" | "upcoming" | "netWorth" | "quickAdd";

interface FinlynqWidgetsNative {
  hasSnapshotReaders(): boolean;
  readSnapshot(): string | null;
  writeSnapshot(json: string): Promise<void>;
  clearSnapshot(): Promise<void>;
  getHideAmounts(): boolean;
  setHideAmounts(hide: boolean): Promise<void>;
  canPinWidgets(): boolean;
  pinWidget(kind: WidgetKindKey): boolean;
}

const native = requireOptionalNativeModule<FinlynqWidgetsNative>("FinlynqWidgets");

/** False in any build without the native module. */
export const widgetsAvailable = native != null;

/** Is a widget that shows figures on a home screen or, on iOS, the Lock Screen? */
export function hasSnapshotReaders(): boolean {
  return native?.hasSnapshotReaders() ?? false;
}

export function readSnapshot(): string | null {
  return native?.readSnapshot() ?? null;
}

export async function writeSnapshot(json: string): Promise<void> {
  await native?.writeSnapshot(json);
}

export async function clearSnapshot(): Promise<void> {
  await native?.clearSnapshot();
}

export function getHideAmounts(): boolean {
  return native?.getHideAmounts() ?? false;
}

export async function setHideAmounts(hide: boolean): Promise<void> {
  await native?.setHideAmounts(hide);
}

/** Can this launcher show its "add this widget" prompt (Android 8+, launcher permitting)? Never on iOS. */
export function canPinWidgets(): boolean {
  return native?.canPinWidgets() ?? false;
}

/** True when the launcher accepted the request; it then asks the user itself. */
export function pinWidget(kind: WidgetKindKey): boolean {
  return native?.pinWidget(kind) ?? false;
}
