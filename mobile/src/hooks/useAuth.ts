import { useState, useEffect, useCallback, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { endpoints, setAuthToken, getAuthToken } from "../api/client";

const BIOMETRIC_KEY = "pf_biometric_enabled";
const AUTO_LOCK_KEY = "pf_auto_lock_minutes";
const PASSPHRASE_KEY = "pf_passphrase";
const SERVER_MODE_KEY = "pf_server_mode";
const SESSION_TOKEN_KEY = "pf_session_token";

export type ServerMode = "self-hosted" | "cloud" | null;

interface AuthState {
  isUnlocked: boolean;
  isLoading: boolean;
  needsSetup: boolean;
  error: string | null;
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  autoLockMinutes: number; // 0 = disabled
  serverMode: ServerMode;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    isUnlocked: false,
    isLoading: true,
    needsSetup: false,
    error: null,
    biometricAvailable: false,
    biometricEnabled: false,
    autoLockMinutes: 5,
    serverMode: null,
  });

  const backgroundedAt = useRef<number | null>(null);

  // Load persisted server mode and session token on mount
  useEffect(() => {
    (async () => {
      const [mode, token] = await Promise.all([
        AsyncStorage.getItem(SERVER_MODE_KEY),
        SecureStore.getItemAsync(SESSION_TOKEN_KEY),
      ]);
      const serverMode = (mode === "self-hosted" || mode === "cloud") ? mode : null;

      // Restore token for cloud mode
      if (serverMode === "cloud" && token) {
        setAuthToken(token);
      }

      setState((s) => ({ ...s, serverMode }));
    })();
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const [res, biometricHw, bioEnabled, autoLockStr] = await Promise.all([
        endpoints.getUnlockStatus(),
        LocalAuthentication.hasHardwareAsync(),
        AsyncStorage.getItem(BIOMETRIC_KEY),
        AsyncStorage.getItem(AUTO_LOCK_KEY),
      ]);

      const autoLock = autoLockStr ? parseInt(autoLockStr, 10) : 5;

      if (res.success) {
        setState((s) => ({
          ...s,
          isUnlocked: res.data.unlocked,
          isLoading: false,
          needsSetup: res.data.needsSetup,
          error: null,
          biometricAvailable: biometricHw,
          biometricEnabled: bioEnabled === "true",
          autoLockMinutes: isNaN(autoLock) ? 5 : autoLock,
        }));
      } else {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: res.error,
          biometricAvailable: biometricHw,
          biometricEnabled: bioEnabled === "true",
          autoLockMinutes: isNaN(autoLock) ? 5 : autoLock,
        }));
      }
    } catch {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: "Cannot connect to server",
      }));
    }
  }, []);

  // Check status once mode is set for self-hosted, or validate token for cloud
  useEffect(() => {
    if (state.serverMode === "self-hosted") {
      checkStatus();
    } else if (state.serverMode === "cloud") {
      // For cloud mode, check if we have a valid token
      const token = getAuthToken();
      if (token) {
        // Validate token by making an API call
        endpoints.getDashboard().then((res) => {
          if (res.success) {
            setState((s) => ({ ...s, isUnlocked: true, isLoading: false }));
          } else {
            // Token expired — clear it
            setAuthToken(null);
            SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
            setState((s) => ({ ...s, isUnlocked: false, isLoading: false }));
          }
        }).catch(() => {
          setState((s) => ({ ...s, isLoading: false, error: "Cannot connect to server" }));
        });
      } else {
        setState((s) => ({ ...s, isLoading: false }));
      }
    } else if (state.serverMode === null) {
      // Mode not selected yet — stop loading
      setState((s) => ({ ...s, isLoading: false }));
    }
  }, [state.serverMode, checkStatus]);

  // Auto-lock on background (self-hosted only)
  useEffect(() => {
    if (state.serverMode !== "self-hosted") return;

    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === "background" || nextState === "inactive") {
        backgroundedAt.current = Date.now();
      } else if (nextState === "active" && backgroundedAt.current) {
        const elapsed = (Date.now() - backgroundedAt.current) / 60000; // minutes
        backgroundedAt.current = null;
        if (
          state.autoLockMinutes > 0 &&
          elapsed >= state.autoLockMinutes &&
          state.isUnlocked
        ) {
          endpoints.lock().then(() => {
            setState((s) => ({ ...s, isUnlocked: false }));
          });
        }
      }
    };

    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [state.serverMode, state.autoLockMinutes, state.isUnlocked]);

  /** Set the server mode (first launch) */
  const selectMode = useCallback(async (mode: "self-hosted" | "cloud") => {
    await AsyncStorage.setItem(SERVER_MODE_KEY, mode);
    setState((s) => ({ ...s, serverMode: mode, isLoading: true }));
  }, []);

  /** Reset mode selection (back to mode selector) */
  const resetMode = useCallback(async () => {
    await AsyncStorage.removeItem(SERVER_MODE_KEY);
    await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
    setAuthToken(null);
    setState((s) => ({
      ...s,
      serverMode: null,
      isUnlocked: false,
      isLoading: false,
      error: null,
    }));
  }, []);

  // --- Self-hosted auth ---
  const unlock = useCallback(async (passphrase: string) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await endpoints.unlock(passphrase);
      if (res.success && res.data.unlocked) {
        setState((s) => ({ ...s, isUnlocked: true, isLoading: false }));
        try {
          await SecureStore.setItemAsync(PASSPHRASE_KEY, passphrase);
        } catch {
          // Non-critical
        }
        return true;
      }
      setState((s) => ({
        ...s,
        isLoading: false,
        error: res.success ? "Unlock failed" : (res as { error: string }).error,
      }));
      return false;
    } catch {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: "Cannot connect to server",
      }));
      return false;
    }
  }, []);

  const biometricUnlock = useCallback(async () => {
    if (!state.biometricEnabled || !state.biometricAvailable) return false;

    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock PF",
        fallbackLabel: "Use Passphrase",
        disableDeviceFallback: false,
      });

      if (!result.success) return false;

      const savedPass = await SecureStore.getItemAsync(PASSPHRASE_KEY);
      if (!savedPass) return false;

      return unlock(savedPass);
    } catch {
      return false;
    }
  }, [state.biometricEnabled, state.biometricAvailable, unlock]);

  const lock = useCallback(async () => {
    if (state.serverMode === "cloud") {
      // Cloud mode: clear token
      setAuthToken(null);
      await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
      setState((s) => ({ ...s, isUnlocked: false }));
    } else {
      await endpoints.lock();
      setState((s) => ({ ...s, isUnlocked: false }));
    }
  }, [state.serverMode]);

  // --- Cloud auth ---
  const login = useCallback(async (email: string, password: string) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await endpoints.login(email, password);
      if (res.ok && res.token) {
        setAuthToken(res.token);
        await SecureStore.setItemAsync(SESSION_TOKEN_KEY, res.token);
        setState((s) => ({ ...s, isUnlocked: true, isLoading: false }));
        return true;
      }
      if (res.data?.mfaRequired) {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: "MFA is not yet supported in the mobile app.",
        }));
        return false;
      }
      const errorMsg = (res.data?.error as string) || "Login failed";
      setState((s) => ({ ...s, isLoading: false, error: errorMsg }));
      return false;
    } catch {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: "Cannot connect to server",
      }));
      return false;
    }
  }, []);

  const register = useCallback(async (email: string, password: string, displayName?: string) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await endpoints.register(email, password, displayName);
      if (res.ok && res.token) {
        setAuthToken(res.token);
        await SecureStore.setItemAsync(SESSION_TOKEN_KEY, res.token);
        setState((s) => ({ ...s, isUnlocked: true, isLoading: false }));
        return true;
      }
      const errorMsg = (res.data?.error as string) || "Registration failed";
      setState((s) => ({ ...s, isLoading: false, error: errorMsg }));
      return false;
    } catch {
      setState((s) => ({
        ...s,
        isLoading: false,
        error: "Cannot connect to server",
      }));
      return false;
    }
  }, []);

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
    selectMode,
    resetMode,
    unlock,
    biometricUnlock,
    lock,
    login,
    register,
    checkStatus,
    setBiometricEnabled,
    setAutoLockMinutes,
    clearError,
  };
}
