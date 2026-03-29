import { useState, useEffect, useCallback, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { endpoints } from "../api/client";

const BIOMETRIC_KEY = "pf_biometric_enabled";
const AUTO_LOCK_KEY = "pf_auto_lock_minutes";
const PASSPHRASE_KEY = "pf_passphrase";

interface AuthState {
  isUnlocked: boolean;
  isLoading: boolean;
  needsSetup: boolean;
  error: string | null;
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  autoLockMinutes: number; // 0 = disabled
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
  });

  const backgroundedAt = useRef<number | null>(null);

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
        setState({
          isUnlocked: res.data.unlocked,
          isLoading: false,
          needsSetup: res.data.needsSetup,
          error: null,
          biometricAvailable: biometricHw,
          biometricEnabled: bioEnabled === "true",
          autoLockMinutes: isNaN(autoLock) ? 5 : autoLock,
        });
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

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Auto-lock on background
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
          state.isUnlocked
        ) {
          // Auto-lock
          endpoints.lock().then(() => {
            setState((s) => ({ ...s, isUnlocked: false }));
          });
        }
      }
    };

    const sub = AppState.addEventListener("change", handleAppState);
    return () => sub.remove();
  }, [state.autoLockMinutes, state.isUnlocked]);

  const unlock = useCallback(async (passphrase: string) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await endpoints.unlock(passphrase);
      if (res.success && res.data.unlocked) {
        setState((s) => ({ ...s, isUnlocked: true, isLoading: false }));
        // Save passphrase for biometric re-unlock
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
    await endpoints.lock();
    setState((s) => ({ ...s, isUnlocked: false }));
  }, []);

  const setBiometricEnabled = useCallback(async (enabled: boolean) => {
    if (enabled) {
      // Verify biometric enrollment
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

  return {
    ...state,
    unlock,
    biometricUnlock,
    lock,
    checkStatus,
    setBiometricEnabled,
    setAutoLockMinutes,
  };
}
