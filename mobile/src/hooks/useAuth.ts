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
  });

  const backgroundedAt = useRef<number | null>(null);

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
            // Token rejected (expired / deploy-rotated) — drop it.
            logger.warn("auth", "stored token rejected by /api/auth/session — dropping");
            setAuthToken(null);
            await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
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

  /** Account login — `identifier` is a username OR email. */
  const signIn = useCallback(async (identifier: string, password: string) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await endpoints.login(identifier.trim(), password);
      if (res.ok) {
        // RN's fetch can't read the httpOnly session cookie, but its native
        // cookie jar auto-resends it on subsequent requests (cookie-based
        // account auth + DEK keyed on the JWT jti). Store the token only if the
        // platform happened to expose it (best-effort Bearer fallback).
        if (res.token) {
          setAuthToken(res.token);
          await SecureStore.setItemAsync(SESSION_TOKEN_KEY, res.token);
        }
        logger.info("auth", "sign-in succeeded", { bearerStored: !!res.token });
        setState((s) => ({
          ...s,
          isUnlocked: true,
          hasSession: true,
          isLoading: false,
        }));
        // The login response doesn't carry admin status; refresh it from the
        // session (rides the cookie jar). Non-blocking so login stays instant.
        getSession()
          .then((sess) =>
            setState((s) => ({ ...s, isAdmin: sess.authenticated ? !!sess.isAdmin : false }))
          )
          .catch(() => {});
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
        logger.info("auth", "register succeeded", { bearerStored: !!res.token });
        setState((s) => ({
          ...s,
          isUnlocked: true,
          hasSession: true,
          isLoading: false,
        }));
        // Pull admin status from the session (non-blocking; cookie-jar backed).
        getSession()
          .then((sess) =>
            setState((s) => ({ ...s, isAdmin: sess.authenticated ? !!sess.isAdmin : false }))
          )
          .catch(() => {});
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

  /** Clear the session token and return to the login screen. */
  const signOut = useCallback(async () => {
    logger.info("auth", "sign-out");
    setAuthToken(null);
    await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
    setState((s) => ({
      ...s,
      isUnlocked: false,
      hasSession: false,
      isAdmin: false,
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
    biometricUnlock,
    saveServerUrl,
    setBiometricEnabled,
    setAutoLockMinutes,
    clearError,
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
