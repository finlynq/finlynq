import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AuthProvider, useAuth } from "../hooks/useAuth";

// Mock the API client so we drive login / session without real fetch. The hook
// imports endpoints/getSession/setAuthToken/getServerUrl/setServerUrl from here.
const mockLogin = jest.fn();
const mockGetSession = jest.fn();
const mockSetAuthToken = jest.fn();
const mockSetAuthFailureHandler = jest.fn();
jest.mock("../api/client", () => ({
  endpoints: {
    login: (...args: unknown[]) => mockLogin(...args),
    register: jest.fn(),
  },
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getServerUrl: jest.fn(() => "http://localhost:3000"),
  setServerUrl: jest.fn(),
  setAuthToken: (...args: unknown[]) => mockSetAuthToken(...args),
  setAuthFailureHandler: (...args: unknown[]) => mockSetAuthFailureHandler(...args),
}));

const SECURE = SecureStore as jest.Mocked<typeof SecureStore>;
const ASYNC = AsyncStorage as jest.Mocked<typeof AsyncStorage>;
const LOCAL = LocalAuthentication as jest.Mocked<typeof LocalAuthentication>;

const SESSION_TOKEN_KEY = "pf_session_token";
const STORED_CREDENTIALS_KEY = "pf_stored_credentials";
const BIOMETRIC_KEY = "pf_biometric_enabled";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

function resetMocks() {
  jest.clearAllMocks();
  // Defaults: no biometric hardware, nothing enrolled, biometric prompt fails.
  LOCAL.hasHardwareAsync.mockResolvedValue(false);
  LOCAL.isEnrolledAsync.mockResolvedValue(true);
  LOCAL.authenticateAsync.mockResolvedValue({ success: false } as never);
  // Storage empty by default.
  SECURE.getItemAsync.mockResolvedValue(null);
  SECURE.setItemAsync.mockResolvedValue(undefined);
  SECURE.deleteItemAsync.mockResolvedValue(undefined);
  ASYNC.getItem.mockResolvedValue(null);
  ASYNC.setItem.mockResolvedValue(undefined);
  mockLogin.mockReset();
  mockGetSession.mockReset();
  mockSetAuthToken.mockReset();
  mockSetAuthFailureHandler.mockReset();
}

describe("useAuth — FINLYNQ-134 biometric silent re-login + secure credential storage", () => {
  beforeEach(resetMocks);

  // tc-1 (primary) — silent re-login on rejected token at bootstrap.
  describe("tc-1 silent re-login on rejected token", () => {
    it("re-logs in once from stored credentials after a biometric prompt, with no manual login", async () => {
      // Stored session token present, biometric hardware + enabled, stored creds.
      SECURE.getItemAsync.mockImplementation(async (key: string) => {
        if (key === SESSION_TOKEN_KEY) return "stale-jwt";
        if (key === STORED_CREDENTIALS_KEY)
          return JSON.stringify({ identifier: "alice", password: "hunter2hunter2" });
        return null;
      });
      ASYNC.getItem.mockImplementation(async (key: string) =>
        key === BIOMETRIC_KEY ? "true" : null
      );
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
      LOCAL.authenticateAsync.mockResolvedValue({ success: true } as never);

      // The stale token is rejected; the re-login then succeeds.
      mockGetSession
        .mockResolvedValueOnce({ authenticated: false }) // bootstrap validation
        .mockResolvedValueOnce({ authenticated: true, isAdmin: false }); // post re-login meta
      mockLogin.mockResolvedValue({ ok: true, status: 200, data: {}, token: "fresh-jwt" });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // endpoints.login called EXACTLY once with the stored identifier+password.
      expect(mockLogin).toHaveBeenCalledTimes(1);
      expect(mockLogin).toHaveBeenCalledWith("alice", "hunter2hunter2");
      // Biometric prompt was shown before the silent login.
      expect(LOCAL.authenticateAsync).toHaveBeenCalled();
      // Session restored straight to the app — no manual login form.
      expect(result.current.hasSession).toBe(true);
      expect(result.current.isUnlocked).toBe(true);
    });

    it("falls back to manual login (no silent login) when the biometric prompt fails", async () => {
      SECURE.getItemAsync.mockImplementation(async (key: string) => {
        if (key === SESSION_TOKEN_KEY) return "stale-jwt";
        if (key === STORED_CREDENTIALS_KEY)
          return JSON.stringify({ identifier: "alice", password: "pw" });
        return null;
      });
      ASYNC.getItem.mockImplementation(async (key: string) =>
        key === BIOMETRIC_KEY ? "true" : null
      );
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
      LOCAL.authenticateAsync.mockResolvedValue({ success: false } as never); // declined
      mockGetSession.mockResolvedValueOnce({ authenticated: false });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(mockLogin).not.toHaveBeenCalled();
      expect(result.current.hasSession).toBe(false);
      expect(result.current.isUnlocked).toBe(false);
    });
  });

  // tc-2 — credentials only ever land in SecureStore, never AsyncStorage.
  describe("tc-2 credentials only in SecureStore", () => {
    it("writes the credential payload to SecureStore and never to AsyncStorage", async () => {
      ASYNC.getItem.mockImplementation(async (key: string) =>
        key === BIOMETRIC_KEY ? "true" : null
      );
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
      LOCAL.isEnrolledAsync.mockResolvedValue(true);
      mockLogin.mockResolvedValue({ ok: true, status: 200, data: {}, token: "jwt" });
      mockGetSession.mockResolvedValue({ authenticated: true, isAdmin: false });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.signIn("alice", "hunter2hunter2");
      });

      // SecureStore received the credential payload under the credential key.
      const credWrite = SECURE.setItemAsync.mock.calls.find(
        ([key]) => key === STORED_CREDENTIALS_KEY
      );
      expect(credWrite).toBeDefined();
      expect(credWrite![1]).toBe(
        JSON.stringify({ identifier: "alice", password: "hunter2hunter2" })
      );

      // No AsyncStorage.setItem call carried the password value.
      const leaked = ASYNC.setItem.mock.calls.some(([, value]) =>
        typeof value === "string" ? value.includes("hunter2hunter2") : false
      );
      expect(leaked).toBe(false);
    });
  });

  // tc-3 — all three teardown paths purge the stored credential.
  describe("tc-3 purge paths", () => {
    async function mountSignedIn() {
      ASYNC.getItem.mockImplementation(async (key: string) =>
        key === BIOMETRIC_KEY ? "true" : null
      );
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
      LOCAL.isEnrolledAsync.mockResolvedValue(true);
      mockLogin.mockResolvedValue({ ok: true, status: 200, data: {}, token: "jwt" });
      mockGetSession.mockResolvedValue({ authenticated: true, isAdmin: false });
      const hook = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
      return hook;
    }

    it("(a) disabling the biometric toggle purges the stored credential", async () => {
      const { result } = await mountSignedIn();
      await act(async () => {
        await result.current.setBiometricEnabled(false);
      });
      expect(SECURE.deleteItemAsync).toHaveBeenCalledWith(STORED_CREDENTIALS_KEY);
    });

    it("(b) signOut purges the stored credential", async () => {
      const { result } = await mountSignedIn();
      SECURE.deleteItemAsync.mockClear();
      await act(async () => {
        await result.current.signOut();
      });
      expect(SECURE.deleteItemAsync).toHaveBeenCalledWith(STORED_CREDENTIALS_KEY);
    });

    it("(c) the wipe-account teardown (signOut) purges the stored credential", async () => {
      // The wipe-account flow's terminal action is signOut (SettingsScreen
      // runDataAction → Alert OK → signOut), which purges the credential.
      const { result } = await mountSignedIn();
      SECURE.deleteItemAsync.mockClear();
      await act(async () => {
        await result.current.signOut(); // same sink the wipe flow invokes
      });
      expect(SECURE.deleteItemAsync).toHaveBeenCalledWith(STORED_CREDENTIALS_KEY);
    });
  });

  // FINLYNQ-135 seam — clearSessionToken clears the token but NOT credentials.
  describe("FINLYNQ-135 seam: clearSessionToken preserves credentials", () => {
    it("deletes the session token but never the credential key", async () => {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      SECURE.deleteItemAsync.mockClear();
      await act(async () => {
        await result.current.clearSessionToken();
      });
      expect(SECURE.deleteItemAsync).toHaveBeenCalledWith(SESSION_TOKEN_KEY);
      expect(SECURE.deleteItemAsync).not.toHaveBeenCalledWith(STORED_CREDENTIALS_KEY);
    });

    it("signOut({ purgeCredentials: false }) preserves credentials", async () => {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      SECURE.deleteItemAsync.mockClear();
      await act(async () => {
        await result.current.signOut({ purgeCredentials: false });
      });
      expect(SECURE.deleteItemAsync).toHaveBeenCalledWith(SESSION_TOKEN_KEY);
      expect(SECURE.deleteItemAsync).not.toHaveBeenCalledWith(STORED_CREDENTIALS_KEY);
    });
  });

  // FINLYNQ-135 — the central 401 auth-failure handler (registered with the API
  // client). This is the useAuth half of tc-1: under the DECLARATIVE navigator,
  // a "navigation reset to login" is achieved by flipping hasSession=false so
  // RootNavigator unmounts the authed tree and renders LoginScreen — there is
  // no imperative reset. So we assert: clears the Bearer token (setAuthToken
  // null) + deletes the SecureStore session token + flips state to logged-out,
  // all WITHOUT purging the FINLYNQ-134 biometric stored credentials.
  describe("FINLYNQ-135 — 401 auth-failure handler (tc-1 useAuth half)", () => {
    /** Mount the hook in a signed-in (unlocked) state. */
    async function mountSignedIn() {
      ASYNC.getItem.mockImplementation(async (key: string) =>
        key === BIOMETRIC_KEY ? "true" : null
      );
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
      LOCAL.isEnrolledAsync.mockResolvedValue(true);
      mockLogin.mockResolvedValue({ ok: true, status: 200, data: {}, token: "jwt" });
      mockGetSession.mockResolvedValue({ authenticated: true, isAdmin: true });
      const hook = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
      await act(async () => {
        await hook.result.current.signIn("alice", "hunter2hunter2");
      });
      await waitFor(() => expect(hook.result.current.hasSession).toBe(true));
      return hook;
    }

    it("registers the handler with the API client on mount", async () => {
      renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(mockSetAuthFailureHandler).toHaveBeenCalled());
      // The registered arg is a function (the handler), not null.
      const registered = mockSetAuthFailureHandler.mock.calls
        .map(([fn]) => fn)
        .find((fn) => typeof fn === "function");
      expect(typeof registered).toBe("function");
    });

    it("clears the Bearer token, deletes the SecureStore session token, and flips to logged-out", async () => {
      const { result } = await mountSignedIn();
      mockSetAuthToken.mockClear();
      SECURE.deleteItemAsync.mockClear();

      await act(async () => {
        result.current.handleAuthFailure();
      });

      // Bearer token cleared.
      expect(mockSetAuthToken).toHaveBeenCalledWith(null);
      // SecureStore session token deleted...
      await waitFor(() =>
        expect(SECURE.deleteItemAsync).toHaveBeenCalledWith(SESSION_TOKEN_KEY)
      );
      // ...but the biometric stored credential is PRESERVED (FINLYNQ-134).
      expect(SECURE.deleteItemAsync).not.toHaveBeenCalledWith(STORED_CREDENTIALS_KEY);
      // Auth state flipped to logged-out → RootNavigator renders LoginScreen
      // (the declarative "navigation reset").
      await waitFor(() => expect(result.current.hasSession).toBe(false));
      expect(result.current.isUnlocked).toBe(false);
      expect(result.current.isAdmin).toBe(false);
    });
  });
});
