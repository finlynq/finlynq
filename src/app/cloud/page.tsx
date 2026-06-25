"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef, Suspense } from "react";
import { AnalyticsConsent } from "@/components/analytics-consent";
import { LogoMark } from "@/components/logo-mark";

type Tab = "login" | "register";

// Live availability check is debounced; this is the wait period.
const USERNAME_CHECK_DEBOUNCE_MS = 350;

type AvailabilityState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available" }
  | { status: "unavailable"; reason: string };

function CloudAuthPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") === "register" ? "register" : "login";
  const redirectTo = searchParams.get("redirect") ?? "/dashboard";
  // ?demo=1 pre-fills the login form with the published demo credentials so
  // a marketing link can drop users one click away from Sign In. Reuses the
  // normal /api/auth/login path (no auto-submit) so the user explicitly
  // consents to the action. For zero-click full auto-login + redirect, see
  // the /try-demo route.
  const demoPrefill = searchParams.get("demo") === "1";
  const [tab, setTab] = useState<Tab>(initialTab);

  // Login form: single 'identifier' field accepts username OR email.
  const [identifier, setIdentifier] = useState(
    demoPrefill ? "demo@finlynq.com" : "",
  );

  // Register form: username (required), email (optional), display name.
  const [username, setUsername] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [acknowledgeNoRecovery, setAcknowledgeNoRecovery] = useState(false);

  const [password, setPassword] = useState(demoPrefill ? "finlynq-demo" : "");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaPendingToken, setMfaPendingToken] = useState("");
  const [mfaCode, setMfaCode] = useState("");

  const [availability, setAvailability] = useState<AvailabilityState>({
    status: "idle",
  });
  const checkSeqRef = useRef(0);

  // Debounced live check against /api/auth/username-check. We bump a
  // sequence number on each fire so a slow earlier response can't overwrite
  // the result of a later input.
  useEffect(() => {
    if (tab !== "register") {
      setAvailability({ status: "idle" });
      return;
    }
    const value = username.trim();
    if (value.length === 0) {
      setAvailability({ status: "idle" });
      return;
    }
    setAvailability({ status: "checking" });
    const seq = ++checkSeqRef.current;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/auth/username-check?u=${encodeURIComponent(value)}`
        );
        const data = await r.json();
        if (seq !== checkSeqRef.current) return;
        if (data.available) {
          setAvailability({ status: "available" });
        } else {
          setAvailability({
            status: "unavailable",
            reason: data.error ?? "Unavailable",
          });
        }
      } catch {
        if (seq !== checkSeqRef.current) return;
        setAvailability({ status: "idle" });
      }
    }, USERNAME_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [username, tab]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }
      if (data.mfaRequired) {
        setMfaRequired(true);
        setMfaPendingToken(data.mfaPendingToken);
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleMfaVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mfaPendingToken, code: mfaCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Verification failed");
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    // Last-mile guard. The server enforces this too, but failing fast in the
    // UI avoids a roundtrip and keeps the message inline.
    if (!registerEmail.trim() && !acknowledgeNoRecovery) {
      setError(
        "Without an email you have no way to recover a forgotten password. Tick the acknowledgement box to proceed."
      );
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          email: registerEmail.trim() || undefined,
          password,
          displayName: displayName || undefined,
          acknowledgeNoRecovery: !registerEmail.trim() ? true : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Registration failed");
        return;
      }
      router.push(redirectTo);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const usernameHelpId = "username-help";
  const showAck = tab === "register" && registerEmail.trim().length === 0;
  const submitDisabled =
    loading ||
    (tab === "register" &&
      (availability.status === "checking" ||
        availability.status === "unavailable" ||
        username.trim().length === 0 ||
        (showAck && !acknowledgeNoRecovery)));

  return (
    <div className="flex min-h-screen items-center justify-center bg-dot-pattern ambient-glow">
      <div className="mx-auto w-full max-w-md px-6 py-12">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back
        </Link>

        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10">
          <span className="[&_svg]:h-9 [&_svg]:w-9">
            <LogoMark />
          </span>
        </div>

        <h1 className="mb-2 text-3xl font-bold tracking-tight text-foreground">
          {tab === "register" ? "Create your free Finlynq account" : "Welcome back"}
        </h1>
        <p className="mb-8 text-muted-foreground">
          {tab === "register"
            ? "Sign up to track your money here and analyze it anywhere. Your data follows you to any device."
            : "Sign in to your account. Your data follows you to any device."}
        </p>
        {tab === "register" && (
          <p className="mb-8 -mt-6 text-xs text-muted-foreground/80">
            Free forever. AGPL v3. Encrypted with your password.
          </p>
        )}

        {mfaRequired ? (
          <form onSubmit={handleMfaVerify} className="space-y-4">
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="mb-3 text-base font-semibold text-foreground">
                Two-Factor Authentication
              </h2>
              <p className="mb-4 text-sm text-muted-foreground">
                Enter the 6-digit code from your authenticator app.
              </p>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                className="w-full rounded-lg border border-border bg-background px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] text-foreground placeholder:text-muted-foreground/40 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading || mfaCode.length !== 6}
              className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Verifying..." : "Verify"}
            </button>
          </form>
        ) : (
          <>
            {demoPrefill && tab === "login" && (
              <div className="mb-6 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-xs text-foreground/90">
                Demo credentials are pre-filled. Just click <strong>Sign In</strong> to
                enter the public demo. Data resets nightly.
              </div>
            )}

            {/* Tab switcher */}
            <div className="mb-6 flex rounded-xl border border-border bg-muted p-1">
              <button
                onClick={() => { setTab("login"); setError(""); }}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  tab === "login"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Sign In
              </button>
              <button
                onClick={() => { setTab("register"); setError(""); }}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  tab === "register"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Create Account
              </button>
            </div>

            <form
              onSubmit={tab === "login" ? handleLogin : handleRegister}
              className="space-y-4"
            >
              {tab === "register" && (
                <>
                  <div>
                    <label htmlFor="displayName" className="mb-1.5 block text-sm font-medium text-foreground">
                      Display Name
                    </label>
                    <input
                      id="displayName"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Your name (optional)"
                      className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>

                  <div>
                    <label htmlFor="username" className="mb-1.5 block text-sm font-medium text-foreground">
                      Username
                    </label>
                    <input
                      id="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="e.g. cool-dragon-99 or anon@madeup.fake"
                      required
                      autoComplete="username"
                      aria-describedby={usernameHelpId}
                      className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      autoFocus
                    />
                    <p
                      id={usernameHelpId}
                      className="mt-1.5 text-xs text-muted-foreground/80"
                    >
                      3 to 254 chars. Letters, digits, and{" "}
                      <span className="font-mono">. @ + _ -</span>. Pick something that hides your
                      identity if your data ever leaks.
                    </p>
                    {availability.status === "checking" && (
                      <p className="mt-1 text-xs text-muted-foreground">Checking…</p>
                    )}
                    {availability.status === "available" && (
                      <p className="mt-1 text-xs text-emerald-500">Available</p>
                    )}
                    {availability.status === "unavailable" && (
                      <p className="mt-1 text-xs text-destructive">{availability.reason}</p>
                    )}
                  </div>
                </>
              )}

              {tab === "login" && (
                <div>
                  <label htmlFor="identifier" className="mb-1.5 block text-sm font-medium text-foreground">
                    Username or email
                  </label>
                  <input
                    id="identifier"
                    type="text"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="username or you@example.com"
                    required
                    autoComplete="username"
                    className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    autoFocus
                  />
                </div>
              )}

              {tab === "register" && (
                <div>
                  <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-foreground">
                    Email <span className="text-muted-foreground/70 font-normal">(optional)</span>
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={registerEmail}
                    onChange={(e) => setRegisterEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground/80">
                    Used only for password reset. Leave it blank for full zero-knowledge, but then you{`’`}ll
                    have no way to recover a forgotten password.
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-foreground">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={tab === "register" ? "At least 12 characters" : "Your password"}
                  required
                  minLength={tab === "register" ? 12 : 1}
                  autoComplete={tab === "register" ? "new-password" : "current-password"}
                  className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              {showAck && (
                <label className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-200/90">
                  <input
                    type="checkbox"
                    checked={acknowledgeNoRecovery}
                    onChange={(e) => setAcknowledgeNoRecovery(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border bg-background accent-primary"
                  />
                  <span>
                    I understand. Finlynq encrypts everything with my password, and there{`’`}s
                    no recovery key. Forgetting it means losing all my data. Without an
                    email I also can{`’`}t reset the password at all.
                  </span>
                </label>
              )}

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}

              <button
                type="submit"
                disabled={submitDisabled}
                className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {loading
                  ? tab === "login" ? "Signing in..." : "Creating account..."
                  : tab === "login" ? "Sign In" : "Create Account"
                }
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-muted-foreground">
              Just looking?{" "}
              <Link
                href="/try-demo?next=/dashboard"
                prefetch={false}
                className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
              >
                One-click demo
              </Link>
              . No signup, resets nightly.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function CloudAuthPage() {
  return (
    <Suspense>
      <AnalyticsConsent />
      <CloudAuthPageInner />
    </Suspense>
  );
}
