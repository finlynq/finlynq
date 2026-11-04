import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { checkForUpdate, type AvailableUpdate } from "../lib/app-update";
import { logger } from "../lib/logger";

const DISMISSED_KEY = "pf_update_dismissed";
// Releases are days apart, so coming back to the app needn't ask every time.
const RECHECK_MS = 12 * 60 * 60 * 1000;

/** A failed check shows nothing: this must never get in the way of the app. */
export function useAppUpdate() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const lastCheck = useRef(0);

  const check = useCallback(async () => {
    if (Date.now() - lastCheck.current < RECHECK_MS) return;
    lastCheck.current = Date.now();
    try {
      const found = await checkForUpdate();
      logger.info("update", "checked", { found: found?.id ?? null });
      const dismissed = found ? await AsyncStorage.getItem(DISMISSED_KEY) : null;
      setUpdate(found && found.id !== dismissed ? found : null);
    } catch (e) {
      logger.warn("update", "check failed", { detail: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => subscription.remove();
  }, [check]);

  const dismiss = useCallback(() => {
    if (!update) return;
    setUpdate(null);
    void AsyncStorage.setItem(DISMISSED_KEY, update.id);
  }, [update]);

  const openStore = useCallback(async () => {
    for (const url of update?.urls ?? []) {
      try {
        await Linking.openURL(url);
        return;
      } catch {
        // No app takes this link on this phone: try the next one.
      }
    }
    logger.warn("update", "could not open the store");
  }, [update]);

  return { update, dismiss, openStore };
}
