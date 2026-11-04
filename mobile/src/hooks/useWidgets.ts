import { useCallback, useEffect, useRef } from "react";
import { AppState, Linking } from "react-native";
import { useNavigationContainerRef } from "@react-navigation/native";
import { setMutationListener } from "../api/client";
import { logger } from "../lib/logger";
import { widgetLinkTarget, type WidgetLinkTarget } from "../lib/widgets/links";
import { syncWidgets } from "../lib/widgets/sync";
import { widgetsAvailable } from "../../modules/finlynq-widgets";

/** Long enough that a burst of saves (a split, a bulk edit) refreshes once. */
const MUTATION_DEBOUNCE_MS = 4000;
const PIN_RETRY_MS = 2000;
/** The tabs mount a moment after unlocking; a pending link waits for them. */
const LINK_RETRY_MS = 300;

/**
 * Keeps the widgets' figures current while the app is unlocked: on unlock, each
 * return to the foreground, and shortly after anything is saved.
 */
export function useWidgetSync(unlocked: boolean) {
  useEffect(() => {
    if (!unlocked || !widgetsAvailable) return;
    void syncWidgets();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pinRetry: ReturnType<typeof setTimeout> | undefined;
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void syncWidgets().then((result) => {
        // Back from the launcher's "add widget" prompt: it may not have placed it yet.
        if (result !== "no-widgets") return;
        clearTimeout(pinRetry);
        pinRetry = setTimeout(() => void syncWidgets(), PIN_RETRY_MS);
      });
    });
    setMutationListener(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void syncWidgets({ force: true }), MUTATION_DEBOUNCE_MS);
    });
    return () => {
      appState.remove();
      clearTimeout(timer);
      clearTimeout(pinRetry);
      setMutationListener(null);
    };
  }, [unlocked]);
}

/**
 * Opens the screen a widget tap asks for. A tap can arrive while the app is
 * locked or signed out, so the link waits until the tabs are there.
 */
export function useWidgetLinks(unlocked: boolean) {
  const navigationRef = useNavigationContainerRef<Record<string, object | undefined>>();
  const pending = useRef<WidgetLinkTarget | null>(null);
  // Read through a ref: the link listener lives for the whole app, across locks.
  const unlockedRef = useRef(unlocked);
  unlockedRef.current = unlocked;

  const openPending = useCallback(() => {
    const target = pending.current;
    if (!target || !unlockedRef.current || !navigationRef.isReady()) return;
    if (!navigationRef.getRootState()?.routeNames?.includes(target.tab)) return;
    pending.current = null;
    if ("screen" in target) {
      // `initial: false` keeps the stack's first screen underneath, for Back.
      navigationRef.navigate(target.tab, { screen: target.screen, initial: false });
    } else {
      navigationRef.navigate(target.tab);
    }
  }, [navigationRef]);

  const receive = useCallback(
    (url: string | null) => {
      const target = widgetLinkTarget(url);
      if (!target) return;
      logger.info("widgets", "link opened", { tab: target.tab });
      pending.current = target;
      openPending();
    },
    [openPending],
  );

  useEffect(() => {
    logger.info("widgets", "native module", { available: widgetsAvailable });
    if (!widgetsAvailable) return;
    void Linking.getInitialURL().then(receive);
    const subscription = Linking.addEventListener("url", ({ url }) => receive(url));
    return () => subscription.remove();
  }, [receive]);

  useEffect(() => {
    if (!unlocked || !pending.current) return;
    const timer = setTimeout(openPending, LINK_RETRY_MS);
    return () => clearTimeout(timer);
  }, [unlocked, openPending]);

  return { navigationRef, onNavigationChange: openPending };
}
