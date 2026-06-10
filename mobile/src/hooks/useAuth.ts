import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useContext,
  createContext,
  createElement,
  type ReactNode,
} from "react";
import { AppState, AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import type { RegisterPayload } from "../../../shared/types";
import {
  endpoints,
  getSession,
  getServerUrl,
  setAuthToken,
  setServerUrl,
} from "../api/client";
import { logger } from "../lib/logger";

const BIOMETRIC_KEY = "pf_biometric_enabled";
const AUTO_LOCK_KEY = "pf_auto_lock_minutes";
const SESSION_TOKEN_KEY = "pf_session_token";
const SERVER_URL_KEY = "pf_server_url";
// FINLYNQ-134 — hardware-backed (Keychain / Keystore) credential store for
// biometric silent re-login. Holds a JSON `{ identifier, password }` so a
// returning user whose stored session JWT has been rejected (deploy-rotated
// DEPLOY_GENERATION / expiry) re-authenticates with a biometric prompt instead
// of re-typing their password. NEVER written to AsyncStorage / plaintext —
// SecureStore only. Purged on toggle-off, signOut, and wipe-account.
const STORED_CREDENTIALS_KEY = "pf_stored_credentials";
// Set once the user has seen the first-run sample-data prompt, so it never nags.
const ONBOARDING_PROMPT_KEY = "pf_onboarding_prompt_shown";

interface StoredCredentials {
  identifier: string;
  password: string;
}

/** Persist identifier+password to hardware-backed SecureStore (biometric-gated
 *  silent re-login). JSON-encoded; SecureStore is the ONLY sink — never write
 *  these to AsyncStorage. */
async function persistCredentials(creds: StoredCredentials): Promise<void> {
  await SecureStore.setItemAsync(STORED_CREDENTIALS_KEY, JSON.stringify(creds));
}

/** Read + parse stored credentials. Returns null if absent or unparseable. */
async function readStoredCredentials(): Promise<StoredCredentials | null> {
  const raw = await SecureStore.getItemAsync(STORED_CREDENTIALS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (typeof parsed?.identifier === "string" && typeof parsed?.password === "string") {
      return { identifier: parsed.identifier, password: parsed.password };
    }
  } catch {
    // Corrupt payload — treat as no stored credentials.
  }
  return null;
}

/** Delete the stored credentials. Idempotent; safe to call when none exist. */
async function purgeStoredCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(STORED_CREDENTIALS_KEY);
}

interface SilentReloginResult {
  /** True when the session was restored (token re-issued + stored). */
  restored: boolean;
  isAdmin: boolean;
}

/**
 * FINLYNQ-134 — silent re-authentication from stored credentials, gated behind
 * a biometric prompt. Called from bootstrap when a stored session token has
 * been rejected. No-ops (returns `restored:false`) unless biometric hardware is
 * present AND biometrics are enabled AND stored credentials exist. On a
 * successful biometric + login it stores the fresh token and reports the admin
 * flag from the session. Any failure (biometric cancel/fail, login reject,
 * network) degrades to `restored:false` so the caller falls back to the manual
 * login screen. Calls `endpoints.login` AT MOST once.
 */
async function attemptSilentRelogin(opts: {
  biometricHw: boolean;
  biometricEnabled: boolean;
}): Promise<SilentReloginResult> {
  const noRestore: SilentReloginResult = { restored: false, isAdmin: false };
  if (!opts.biometricHw || !opts.biometricEnabled) return noRestore;

  const creds = await readStoredCredentials();
  if (!creds) return noRestore;

  // Gate the silent re-login behind a successful biometric prompt.
  let bio: { success: boolean };
  try {
    bio = await LocalAuthentication.authenticateAsync({
      promptMessage: "Sign in to Finlynq",
      fallbackLabel: "Use Password",
      disableDeviceFallback: false,
    });
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logger.warn("auth", "silent re-login: biometric prompt threw", { detail });
    return noRestore;
  }
  if (!bio.success) {
    logger.info("auth", "silent re-login: biometric declined — falling back to manual login");
    return noRestore;
  }

  // Re-authenticate with the stored credentials exactly once.
  try {
    const res = await endpoints.login(creds.identifier, creds.password);
    if (!res.ok) {
      logger.warn("auth", "silent re-login: stored credentials rejected", { status: res.status });
      return noRestore;
    }
    if (res.token) {
      setAuthToken(res.token);
      await SecureStore.setItemAsync(SESSION_TOKEN_KEY, res.token);
    }
    let isAdmin = false;
    try {
      const sess = await getSession();
      isAdmin = sess.authenticated ? !!sess.isAdmin : false;
    } catch {
      // Session-meta refresh failed; the re-login itself succeeded (cookie jar
      // carries the session). Default admin to false rather than block entry.
    }
    logger.info("auth", "silent re-login succeeded", { bearerStored: !!res.token });
    return { restored: true, isAdmin };
  } catch (e) {
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logger.warn("auth", "silent re-login: login threw", { detail });
    return noRestore;
  }
}

interface AuthState {
  /** UI gate the navigator reads — true means show the main app. */
  isUnlocked: boolean;
  /** We hold a session token that validated against /api/auth/session. May be
   *  locked behind biometrics (hasSession true + isUnlocked false). */
  hasSession: boolean;
  isLoading: boolean;
  error: string | null;
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  autoLockMinutes: number; // 0 = disabled
  /** Admin flag from GET /api/auth/session — gates the Diagnostics panel. */
  isAdmin: boolean;
  /** True after a fresh register / first sign-in of an un-onboarded account —
   *  the navigator shows the sample-data prompt. Never set during bootstrap. */
  pendingOnboarding: boolean;
}

export type { RegisterPayload };

function useAuthEngine() {
  const [state, setState] = useState<AuthState>({
    isUnlocked: false,
    hasSession: false,
    isLoading: true,
    error: null,
    biometricAvailable: false,
    biometricEnabled: false,
    autoLockMinutes: 5,
    isAdmin: false,
    pendingOnboarding: false,
  });

  const backgroundedAt = useRef<number | null>(null);

  // FINLYNQ-134 — the most recent successful login credentials, kept in memory
  // only so `setBiometricEnabled(true)` can persist them when the user opts into
  // biometric sign-in right after a manual login (the password is no longer in
  // scope on the Settings screen). Cleared on signOut. Never persisted here.
  const lastCredentials = useRef<StoredCredentials | null>(null);
  // Mirror of `biometricEnabled` so the empty-deps `signIn` callback always
  // reads the freshest value without re-creating the callback (matches the
  // existing stable-callback pattern in this hook).
  const biometricEnabledRef = useRef(false);

  // Bootstrap: restore the server URL + biometric prefs, then validate any
  // stored session token against the backend's single identity source.
  useEffect(() => {
    (async () => {
      const [storedUrl, biometricHw, bioEnabled, autoLockStr, token] =
        await Promise.all([
          AsyncStorage.getItem(SERVER_URL_KEY),
          LocalAuthentication.hasHardwareAsync(),
          AsyncStorage.getItem(BIOMETRIC_KEY),
          AsyncStorage.getItem(AUTO_LOCK_KEY),
          SecureStore.getItemAsync(SESSION_TOKEN_KEY),
        ]);

      if (storedUrl) setServerUrl(storedUrl);
      const autoLock = autoLockStr ? parseInt(autoLockStr, 10) : 5;
      const biometricEnabled = bioEnabled === "true";

      logger.info("auth", "bootstrap", {
        serverUrl: getServerUrl(),
        hasStoredToken: !!token,
        biometricHw,
        biometricEnabled,
        autoLock,
      });

      let isUnlocked = false;
      let hasSession = false;
      let isAdmin = false;

      if (token) {
        setAuthToken(token);
        try {
          const session = await getSession();
          if (session.authenticated) {
            hasSession = true;
            isAdmin = !!session.isAdmin;
            // Gate behind biometrics when enabled; otherwise unlock straight away.
            isUnlocked = !(biometricHw && biometricEnabled);
          } else {
            // Token rejected (expired / deploy-rotated) — drop it. FINLYNQ-134:
            // before falling back to the manual login form, attempt a silent,
            // biometric-gated re-login from stored credentials so a returning
            // user (esp. after a deploy rotates DEPLOY_GENERATION) doesn't have
            // to re-type their password.
            logger.warn("auth", "stored token rejected by /api/auth/session — dropping");
            setAuthToken(null);
            await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
            const relogin = await attemptSilentRelogin({ biometricHw, biometricEnabled });
            if (relogin.restored) {
              hasSession = true;
              isUnlocked = true;
              isAdmin = relogin.isAdmin;
            }
          }
        } catch (e) {
          // Couldn't reach the server. Keep the stored token (it may still be
          // valid once the URL/network is fixed) but fall through to the login
          // screen so the user can retry or correct the server URL.
          const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          logger.error("auth", "session validation threw during bootstrap", { detail });
        }
      }

      setState((s) => ({
        ...s,
        isUnlocked,
        hasSession,
        isAdmin,
        isLoading: false,
        biometricAvailable: biometricHw,
        biometricEnabled,
        autoLockMinutes: isNaN(autoLock) ? 5 : autoLock,
      }));
    })();
  }, []);

  // Keep the biometric-enabled ref in sync with state so the empty-deps signIn
  // callback persists credentials based on the live preference.
  useEffect(() => {
    biometricEnabledRef.current = state.biometricEnabled;
  }, [state.biometricEnabled]);

  // Auto-lock on background. Only re-locks when biometrics are available AND
  // enabled — without a biometric unlock path, locking would strand the user
  // with no way back in short of a full re-login.
  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === "background" || nextState === "inactive") {
        backgroundedAt.current = Date.now();
      } else if (nextState === "active" && backgroundedAt.current) {
        const elapsed = (Date.now() - backgroundedAt.current) / 60000; // minutes
        backgroundedAt.current = null;
        if (
          state.autoLockMinutes > 0 &&
          elapsed >= state.autoLockMinutes &&
          state.isUnlocked &&
          state.biometricAvailable &&
          state.biometricEnabled
        ) {
          // Lock the UI but keep the session token; biometric re-unlocks.
          setState((s) => ({ ...s, isUnlocked: false }));
        }
      }
    };

    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [
    state.autoLockMinutes,
    state.isUnlocked,
    state.biometricAvailable,
    state.biometricEnabled,
  ]);

  /** Persist + apply the backend server URL (used by the login + settings screens). */
  const saveServerUrl = useCallback(async (url: string) => {
    const cleaned = url.trim().replace(/\/$/, "");
    setServerUrl(cleaned);
    await AsyncStorage.setItem(SERVER_URL_KEY, cleaned);
  }, []);

  /** Refresh session-derived state after a fresh login/register: admin flag +
   *  whether to show the first-run sample-data prompt. Only fires on explicit
   *  sign-in/register (NOT bootstrap), so a returning user is never re-prompted.
   *  Non-blocking; rides the cookie jar. */
  const refreshSessionMeta = useCallback(() => {
    getSession()
      .then(async (sess) => {
        const isAdmin = sess.authenticated ? !!sess.isAdmin : false;
        let pendingOnboarding = false;
        if (sess.authenticated && sess.onboardingComplete !== true) {
          const shown = await AsyncStorage.getItem(ONBOARDING_PROMPT_KEY);
          pendingOnboarding = shown !== "true";
        }
        setState((s) => ({ ...s, isAdmin, pendingOnboarding }));
      })
      .catch(() => {});
  }, []);

  /** Dismiss the first-run prompt and remember it so it never shows again. */
  const dismissOnboarding = useCallback(async () => {
    await AsyncStorage.setItem(ONBOARDING_PROMPT_KEY, "true");
    setState((s) => ({ ...s, pendingOnboarding: false }));
  }, []);

  /** Account login — `identifier` is a username OR email. */
  const signIn = useCallback(async (identifier: string, password: string) => {
    const trimmedId = identifier.trim();
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await endpoints.login(trimmedId, password);
      if (res.ok) {
        // RN's fetch can't read the httpOnly session cookie, but its native
        // cookie jar auto-resends it on subsequent requests (cookie-based
        // account auth + DEK keyed on the JWT jti). Store the token only if the
        // platform happened to expose it (best-effort Bearer fallback).
        if (res.token) {
          setAuthToken(res.token);
          await SecureStore.setItemAsync(SESSION_TOKEN_KEY, res.token);
        }
        // FINLYNQ-134 — keep the credentials in memory so opting into biometric
        // sign-in right after this login can persist them; and if biometric
        // sign-in is already enabled, persist them now (hardware-backed
        // SecureStore only) so the next deploy-rotated launch re-logs in
        // silently after a biometric prompt.
        const creds: StoredCredentials = { identifier: trimmedId, password };
        lastCredentials.current = creds;
        if (biometricEnabledRef.current) {
          await persistCredentials(creds);
        }
        logger.info("auth", "sign-in succeeded", { bearerStored: !!res.token });
        setState((s) => ({
          ...s,
          isUnlocked: true,
          hasSession: true,
          isLoading: false,
        }));
        // The login response doesn't carry admin/onboarding status; refresh it
        // from the session (rides the cookie jar). Non-blocking so login stays
        // instant. Also decides whether to show the first-run sample-data prompt.
        refreshSessionMeta();
        return true;
      }
      if (res.data?.mfaRequired) {
        logger.warn("auth", "sign-in blocked: MFA required (unsupported on mobile)");
        setState((s) => ({
          ...s,
          isLoading: false,
          error:
            "Two-factor authentication isn't supported in the mobile app yet. Sign in on the web.",
        }));
        return false;
      }
      const errorMsg = (res.data?.error as string) || "Sign in failed";
      logger.warn("auth", "sign-in rejected", { status: res.status, error: errorMsg });
      setState((s) => ({ ...s, isLoading: false, error: errorMsg }));
      return false;
    } catch (e) {
      // Log the real exception; show the user a clean message.
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("auth", "sign-in threw (network/JS error)", {
        detail,
        serverUrl: getServerUrl(),
      });
      setState((s) => ({
        ...s,
        isLoading: false,
        error: "Can't reach the server. Check your connection and server URL.",
      }));
      return false;
    }
  }, []);

  /** Create a new account. Username is required; email is optional recovery. */
  const register = useCallback(async (payload: RegisterPayload) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await endpoints.register(payload);
      if (res.ok) {
        // RN's fetch can't read the httpOnly session cookie, but its native
        // cookie jar auto-resends it on subsequent requests (cookie-based
        // account auth + DEK keyed on the JWT jti). Store the token only if the
        // platform happened to expose it (best-effort Bearer fallback).
        if (res.token) {
          setAuthToken(res.token);
          await SecureStore.setItemAsync(SESSION_TOKEN_KEY, res.token);
        }
        // FINLYNQ-134 — same credential capture as signIn (see there): remember
        // for a post-register biometric opt-in, and persist now if biometric
        // sign-in is already on.
        const creds: StoredCredentials = { identifier: payload.username, password: payload.password };
        lastCredentials.current = creds;
        if (biometricEnabledRef.current) {
          await persistCredentials(creds);
        }
        logger.info("auth", "register succeeded", { bearerStored: !!res.token });
        setState((s) => ({
          ...s,
          isUnlocked: true,
          hasSession: true,
          isLoading: false,
        }));
        // A brand-new account is un-onboarded → this also flags the first-run
        // sample-data prompt (non-blocking; cookie-jar backed).
        refreshSessionMeta();
        return true;
      }
      const errorMsg = (res.data?.error as string) || "Registration failed";
      logger.warn("auth", "register rejected", { status: res.status, error: errorMsg });
      setState((s) => ({ ...s, isLoading: false, error: errorMsg }));
      return false;
    } catch (e) {
      // Log the real exception; show the user a clean message.
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("auth", "register threw (network/JS error)", {
        detail,
        serverUrl: getServerUrl(),
      });
      setState((s) => ({
        ...s,
        isLoading: false,
        error: "Can't reach the server. Check your connection and server URL.",
      }));
      return false;
    }
  }, []);

  /**
   * Clear just the stored session token + in-memory auth token, leaving the
   * biometric-gated stored credentials INTACT. Does NOT touch UI auth state.
   *
   * FINLYNQ-135 seam: a central 401 auth-failure interceptor should call this
   * (NOT `signOut`) so that the next launch can silently re-login from the
   * preserved credentials after a biometric prompt. Keep token-clear and
   * credential-purge strictly separate: `signOut` purges credentials, this does
   * not.
   */
  const clearSessionToken = useCallback(async () => {
    setAuthToken(null);
    await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
  }, []);

  /**
   * Clear the session token and return to the login screen. By default this
   * also purges the biometric stored credentials (an explicit user sign-out is
   * a full teardown). Pass `{ purgeCredentials: false }` to clear only the
   * session — reserved for the FINLYNQ-135 forced-logout/401 path, which wants
   * silent re-login to still work next launch.
   *
   * The parameter is typed loosely (`unknown`) so `signOut` can still be passed
   * directly as a React Native event handler (Alert `onPress` / `Switch`
   * `onValueChange`) without a type clash — only a real `{ purgeCredentials }`
   * object is honoured; any other arg (an event / string) falls through to the
   * default full purge.
   */
  const signOut = useCallback(async (opts?: unknown) => {
    const purge =
      !(
        typeof opts === "object" &&
        opts !== null &&
        (opts as { purgeCredentials?: boolean }).purgeCredentials === false
      );
    logger.info("auth", "sign-out", { purgeCredentials: purge });
    setAuthToken(null);
    await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
    if (purge) {
      lastCredentials.current = null;
      await purgeStoredCredentials();
    }
    setState((s) => ({
      ...s,
      isUnlocked: false,
      hasSession: false,
      isAdmin: false,
      pendingOnboarding: false,
      error: null,
    }));
  }, []);

  /** Unlock the UI with biometrics. The session token already lives in
   *  SecureStore — biometrics only gate the local UI, they don't re-auth. */
  const biometricUnlock = useCallback(async () => {
    if (!state.biometricEnabled || !state.biometricAvailable) return false;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock Finlynq",
        fallbackLabel: "Use Password",
        disableDeviceFallback: false,
      });
      if (!result.success) return false;
      setState((s) => ({ ...s, isUnlocked: true }));
      return true;
    } catch {
      return false;
    }
  }, [state.biometricEnabled, state.biometricAvailable]);

  const setBiometricEnabled = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!enrolled) {
        setState((s) => ({ ...s, error: "No biometrics enrolled on this device" }));
        return;
      }
    }
    await AsyncStorage.setItem(BIOMETRIC_KEY, String(enabled));
    biometricEnabledRef.current = enabled;
    if (enabled) {
      // FINLYNQ-134 — opting in right after a manual login persists the
      // in-memory credentials so the next deploy-rotated launch re-logs in
      // silently. If there are none in scope (e.g. toggled before any login
      // this session) the next successful signIn captures + persists them.
      if (lastCredentials.current) {
        await persistCredentials(lastCredentials.current);
      }
    } else {
      // Disabling biometric sign-in is one of the three teardown paths — purge
      // the hardware-backed credential store.
      lastCredentials.current = null;
      await purgeStoredCredentials();
    }
    setState((s) => ({ ...s, biometricEnabled: enabled }));
  }, []);

  const setAutoLockMinutes = useCallback(async (minutes: number) => {
    await AsyncStorage.setItem(AUTO_LOCK_KEY, String(minutes));
    setState((s) => ({ ...s, autoLockMinutes: minutes }));
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return {
    ...state,
    signIn,
    register,
    signOut,
    // FINLYNQ-135 seam: clears the session token WITHOUT purging the biometric
    // stored credentials, so silent re-login still works on next launch.
    clearSessionToken,
    biometricUnlock,
    saveServerUrl,
    setBiometricEnabled,
    setAutoLockMinutes,
    clearError,
    dismissOnboarding,
  };
}

export type AuthValue = ReturnType<typeof useAuthEngine>;

// Auth state is shared via context so the navigator and the settings screen
// read/write the SAME instance. Without this, signing out from Settings would
// only mutate that screen's local state and never return the app to login.
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const value = useAuthEngine();
  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
