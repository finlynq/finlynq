import { useState, useEffect, useCallback } from "react";
import { endpoints } from "../api/client";

interface AuthState {
  isUnlocked: boolean;
  isLoading: boolean;
  needsSetup: boolean;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    isUnlocked: false,
    isLoading: true,
    needsSetup: false,
    error: null,
  });

  const checkStatus = useCallback(async () => {
    try {
      const res = await endpoints.getUnlockStatus();
      if (res.success) {
        setState({
          isUnlocked: res.data.unlocked,
          isLoading: false,
          needsSetup: res.data.needsSetup,
          error: null,
        });
      } else {
        setState((s) => ({ ...s, isLoading: false, error: res.error }));
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

  const unlock = useCallback(async (passphrase: string) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await endpoints.unlock(passphrase);
      if (res.success && res.data.unlocked) {
        setState((s) => ({ ...s, isUnlocked: true, isLoading: false }));
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

  const lock = useCallback(async () => {
    await endpoints.lock();
    setState((s) => ({ ...s, isUnlocked: false }));
  }, []);

  return { ...state, unlock, lock, checkStatus };
}
