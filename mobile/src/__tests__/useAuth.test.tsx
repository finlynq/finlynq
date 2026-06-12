import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AuthProvider, useAuth, type BiometricEnableResult } from "../hooks/useAuth";

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
      // The credential was read through the OS-auth-gated secure store — the
      // requireAuthentication read IS the biometric gate (no separate prompt).
      expect(SECURE.getItemAsync).toHaveBeenCalledWith(
        STORED_CREDENTIALS_KEY,
        expect.objectContaining({ requireAuthentication: true })
      );
      // Session restored straight to the app — no manual login form.
      expect(result.current.hasSession).toBe(true);
      expect(result.current.isUnlocked).toBe(true);
    });

    it("falls back to manual login when the OS-auth-gated credential read is denied", async () => {
      SECURE.getItemAsync.mockImplementation(async (key: string) => {
        if (key === SESSION_TOKEN_KEY) return "stale-jwt";
        // The secured credential read throws when the OS biometric/passcode is
        // cancelled or the Keystore key was invalidated by an enrollment change.
        if (key === STORED_CREDENTIALS_KEY) throw new Error("UserCanceled");
        return null;
      });
      ASYNC.getItem.mockImplementation(async (key: string) =>
        key === BIOMETRIC_KEY ? "true" : null
      );
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
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
      // ...and the write is bound to an OS auth gate (requireAuthentication).
      expect(credWrite![2]).toEqual(
        expect.objectContaining({ requireAuthentication: true })
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

    it("clears the Bearer token, deletes the SecureStore session token, and flips to logged-out when silent re-login is unavailable", async () => {
      const { result } = await mountSignedIn();
      // No stored credentials are readable → silent re-login can't run.
      SECURE.getItemAsync.mockResolvedValue(null);
      mockSetAuthToken.mockClear();
      SECURE.deleteItemAsync.mockClear();
      mockLogin.mockClear();

      let restored: boolean | undefined;
      await act(async () => {
        restored = await result.current.handleAuthFailure();
      });

      // No silent re-login happened (no creds) → not restored.
      expect(restored).toBe(false);
      expect(mockLogin).not.toHaveBeenCalled();
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

    // session-locked recovery — when biometric creds ARE stored, a mid-session
    // auth failure (401 / 423 session_locked) heals IN PLACE via silent
    // re-login instead of bouncing the user to the login screen.
    it("restores the session in place via silent re-login when biometric creds are stored", async () => {
      const { result } = await mountSignedIn();
      // The OS-auth-gated credential read returns the stored creds.
      SECURE.getItemAsync.mockImplementation(async (key: string) =>
        key === STORED_CREDENTIALS_KEY
          ? JSON.stringify({ identifier: "alice", password: "hunter2hunter2" })
          : key === SESSION_TOKEN_KEY
            ? "jwt"
            : null
      );
      mockGetSession.mockResolvedValue({ authenticated: true, isAdmin: true });
      mockSetAuthToken.mockClear();
      SECURE.deleteItemAsync.mockClear();
      mockLogin.mockClear();
      mockLogin.mockResolvedValue({ ok: true, status: 200, data: {}, token: "fresh-jwt" });

      let restored: boolean | undefined;
      await act(async () => {
        restored = await result.current.handleAuthFailure();
      });

      // Healed in place: a full re-login ran (re-derives JWT + DEK server-side)...
      expect(restored).toBe(true);
      expect(mockLogin).toHaveBeenCalledTimes(1);
      expect(mockLogin).toHaveBeenCalledWith("alice", "hunter2hunter2");
      // ...the credential read was OS-auth-gated...
      expect(SECURE.getItemAsync).toHaveBeenCalledWith(
        STORED_CREDENTIALS_KEY,
        expect.objectContaining({ requireAuthentication: true })
      );
      // ...and the session was NOT torn down (user stays in the app).
      expect(result.current.hasSession).toBe(true);
      expect(result.current.isUnlocked).toBe(true);
      expect(SECURE.deleteItemAsync).not.toHaveBeenCalledWith(SESSION_TOKEN_KEY);
    });
  });

  // FINLYNQ-134 (fix) — the on-device bug: enabling biometric sign-in in
  // Settings while ALREADY logged in (no password in memory) stored nothing, so
  // silent re-login silently no-opped. The fix captures the credential at
  // enable-time (prompting for the password) and makes bootstrap re-login work
  // even when no session token is present (a prior 401 cleared it).
  describe("FINLYNQ-134 fix — enable-time credential capture + tokenless re-login", () => {
    /** Bootstrap signed-in WITHOUT calling signIn, so no credentials are in
     *  memory — models a user already logged in from a prior launch. */
    async function mountAlreadyLoggedIn() {
      SECURE.getItemAsync.mockImplementation(async (key: string) =>
        key === SESSION_TOKEN_KEY ? "live-jwt" : null
      );
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
      LOCAL.isEnrolledAsync.mockResolvedValue(true);
      mockGetSession.mockResolvedValue({
        authenticated: true,
        isAdmin: false,
        username: "alice",
      });
      const hook = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
      return hook;
    }

    it("enabling while already logged in (no creds in memory) asks for a password and stores nothing yet", async () => {
      const { result } = await mountAlreadyLoggedIn();
      SECURE.setItemAsync.mockClear();
      let res: BiometricEnableResult | undefined;
      await act(async () => {
        res = await result.current.setBiometricEnabled(true);
      });
      // Caller is told to prompt for the password...
      expect(res).toEqual({ ok: false, needsPassword: true });
      // ...and nothing was persisted (no credential write, toggle stays off).
      const credWrite = SECURE.setItemAsync.mock.calls.find(
        ([k]) => k === STORED_CREDENTIALS_KEY
      );
      expect(credWrite).toBeUndefined();
      expect(result.current.biometricEnabled).toBe(false);
    });

    it("enabling with a verified password captures the credential and turns biometrics on", async () => {
      const { result } = await mountAlreadyLoggedIn();
      mockLogin.mockResolvedValue({ ok: true, status: 200, data: {}, token: "fresh-jwt" });
      SECURE.setItemAsync.mockClear();
      let res: BiometricEnableResult | undefined;
      await act(async () => {
        res = await result.current.setBiometricEnabled(true, { password: "hunter2hunter2" });
      });
      expect(res).toEqual({ ok: true });
      // Password verified via login using the identifier from the live session.
      expect(mockLogin).toHaveBeenCalledWith("alice", "hunter2hunter2");
      // Credential persisted to SecureStore only, exactly as typed.
      const credWrite = SECURE.setItemAsync.mock.calls.find(
        ([k]) => k === STORED_CREDENTIALS_KEY
      );
      expect(credWrite).toBeDefined();
      expect(credWrite![1]).toBe(
        JSON.stringify({ identifier: "alice", password: "hunter2hunter2" })
      );
      expect(result.current.biometricEnabled).toBe(true);
    });

    it("a wrong password is rejected at enable-time — no credential stored, toggle stays off", async () => {
      const { result } = await mountAlreadyLoggedIn();
      mockLogin.mockResolvedValue({ ok: false, status: 401, data: { error: "Invalid credentials" } });
      SECURE.setItemAsync.mockClear();
      let res: BiometricEnableResult | undefined;
      await act(async () => {
        res = await result.current.setBiometricEnabled(true, { password: "wrong" });
      });
      expect(res).toEqual({ ok: false, error: "Invalid credentials" });
      const credWrite = SECURE.setItemAsync.mock.calls.find(
        ([k]) => k === STORED_CREDENTIALS_KEY
      );
      expect(credWrite).toBeUndefined();
      expect(result.current.biometricEnabled).toBe(false);
    });

    it("silently re-logs in at bootstrap even with NO stored session token (a prior 401 cleared it)", async () => {
      // No session token at all, but biometrics enabled + credentials stored.
      SECURE.getItemAsync.mockImplementation(async (key: string) => {
        if (key === STORED_CREDENTIALS_KEY)
          return JSON.stringify({ identifier: "alice", password: "hunter2hunter2" });
        return null; // SESSION_TOKEN_KEY absent — previously made re-login unreachable
      });
      ASYNC.getItem.mockImplementation(async (key: string) =>
        key === BIOMETRIC_KEY ? "true" : null
      );
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
      mockLogin.mockResolvedValue({ ok: true, status: 200, data: {}, token: "fresh-jwt" });
      mockGetSession.mockResolvedValue({ authenticated: true, isAdmin: false });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Re-login fired once from the stored creds despite there being no token,
      // gated by the OS-auth-bound secured read.
      expect(mockLogin).toHaveBeenCalledTimes(1);
      expect(mockLogin).toHaveBeenCalledWith("alice", "hunter2hunter2");
      expect(SECURE.getItemAsync).toHaveBeenCalledWith(
        STORED_CREDENTIALS_KEY,
        expect.objectContaining({ requireAuthentication: true })
      );
      expect(result.current.hasSession).toBe(true);
      expect(result.current.isUnlocked).toBe(true);
    });
  });

  // FINLYNQ-134 — login-screen biometric opt-in. The LoginScreen checkbox passes
  // { enableBiometric: true } to signIn so the password is captured AT login (the
  // structural fix for "enabled in Settings but nothing stored").
  describe("FINLYNQ-134 — login-screen biometric opt-in (signIn enableBiometric)", () => {
    it("enables biometric + stores credentials when opted in at login and enrolled", async () => {
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
      LOCAL.isEnrolledAsync.mockResolvedValue(true);
      mockLogin.mockResolvedValue({ ok: true, status: 200, data: {}, token: "jwt" });
      mockGetSession.mockResolvedValue({ authenticated: true, isAdmin: false });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.signIn("alice", "hunter2hunter2", { enableBiometric: true });
      });

      // Credentials persisted to the OS-auth-gated secure store...
      const credWrite = SECURE.setItemAsync.mock.calls.find(
        ([key]) => key === STORED_CREDENTIALS_KEY
      );
      expect(credWrite).toBeDefined();
      expect(credWrite![1]).toBe(
        JSON.stringify({ identifier: "alice", password: "hunter2hunter2" })
      );
      expect(credWrite![2]).toEqual(
        expect.objectContaining({ requireAuthentication: true })
      );
      // ...and biometric is flipped on (persisted flag + state).
      expect(ASYNC.setItem).toHaveBeenCalledWith(BIOMETRIC_KEY, "true");
      await waitFor(() => expect(result.current.biometricEnabled).toBe(true));
    });

    it("does NOT enable biometric when opted in but no biometric is enrolled", async () => {
      LOCAL.hasHardwareAsync.mockResolvedValue(true);
      LOCAL.isEnrolledAsync.mockResolvedValue(false);
      mockLogin.mockResolvedValue({ ok: true, status: 200, data: {}, token: "jwt" });
      mockGetSession.mockResolvedValue({ authenticated: true, isAdmin: false });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.signIn("alice", "hunter2hunter2", { enableBiometric: true });
      });

      // Not enrolled → biometric stays off and no credential is stored.
      expect(ASYNC.setItem).not.toHaveBeenCalledWith(BIOMETRIC_KEY, "true");
      const credWrite = SECURE.setItemAsync.mock.calls.find(
        ([key]) => key === STORED_CREDENTIALS_KEY
      );
      expect(credWrite).toBeUndefined();
      expect(result.current.biometricEnabled).toBe(false);
    });
  });
});
