"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ShieldCheck, Database, TrendingUp, PiggyBank, Target, AlertTriangle, Loader2 } from "lucide-react";

const PERMISSIONS = [
  { icon: Database, text: "Read your accounts and balances" },
  { icon: TrendingUp, text: "Read your transactions and portfolio" },
  { icon: PiggyBank, text: "Read your budgets and spending data" },
  { icon: Target, text: "Read your goals and financial health" },
];

/** Map known client_ids to human-readable names */
function clientName(clientId: string): string {
  const known: Record<string, string> = {
    "claude.ai": "Claude",
    "claude-desktop": "Claude Desktop",
    "cursor": "Cursor",
    "cline": "Cline",
  };
  return known[clientId] ?? clientId;
}

function AuthorizePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const clientId = searchParams.get("client_id") ?? "";
  const redirectUri = searchParams.get("redirect_uri") ?? "";
  const responseType = searchParams.get("response_type") ?? "";
  const state = searchParams.get("state") ?? "";
  const codeChallenge = searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod = searchParams.get("code_challenge_method") ?? "S256";

  const [sessionState, setSessionState] = useState<"loading" | "loggedIn" | "loggedOut">("loading");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Check if user is logged in. `/api/auth/unlock` was removed in the SQLite
  // purge (db9fd75) — /api/auth/session is the single source of truth now.
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        setSessionState(data.authenticated ? "loggedIn" : "loggedOut");
      })
      .catch(() => setSessionState("loggedOut"));
  }, []);

  // If not logged in, redirect to login with a return URL
  useEffect(() => {
    if (sessionState === "loggedOut") {
      const returnUrl = `/oauth/authorize?${searchParams.toString()}`;
      router.replace(`/cloud?redirect=${encodeURIComponent(returnUrl)}`);
    }
  }, [sessionState, searchParams, router]);

  // Validate required params
  const paramError = !clientId
    ? "Missing client_id"
    : !redirectUri
      ? "Missing redirect_uri"
      : responseType !== "code"
        ? "response_type must be 'code'"
        : !codeChallenge
          ? "Missing code_challenge (PKCE required)"
          : null;

  async function handleAllow() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "allow",
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.redirectTo) {
        setError(data.error ?? "Authorization failed");
        return;
      }
      window.location.href = data.redirectTo;
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleDeny() {
    if (!redirectUri) return;
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "The user denied access");
    if (state) url.searchParams.set("state", state);
    window.location.href = url.toString();
  }

  if (sessionState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (paramError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background bg-dot-pattern">
        <div className="mx-auto w-full max-w-md px-6 py-12 text-center space-y-4">
          <AlertTriangle className="h-12 w-12 text-amber-400 mx-auto" />
          <h1 className="text-xl font-bold text-foreground">Invalid Request</h1>
          <p className="text-sm text-muted-foreground">{paramError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background bg-dot-pattern ambient-glow">
      <div className="mx-auto w-full max-w-sm px-6 py-12">
        {/* Logo + connecting indicator */}
        <div className="flex items-center justify-center gap-4 mb-8">
          {/* Finlynq logo */}
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-purple-600 shadow-lg shadow-indigo-500/30">
            <span className="text-lg font-bold text-white tracking-tight">PF</span>
          </div>
          {/* Connection dots */}
          <div className="flex items-center gap-1">
            <div className="h-1.5 w-1.5 rounded-full bg-border" />
            <div className="h-1.5 w-1.5 rounded-full bg-border" />
            <div className="h-1.5 w-1.5 rounded-full bg-border" />
          </div>
          {/* Client placeholder icon */}
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted border border-border shadow">
            <span className="text-xl">🤖</span>
          </div>
        </div>

        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Authorize <span className="text-primary">{clientName(clientId)}</span>
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {clientName(clientId)} is requesting access to your Finlynq financial data.
          </p>
        </div>

        {/* Permissions list */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3 mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1">
            This will allow {clientName(clientId)} to:
          </p>
          {PERMISSIONS.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Icon className="h-3.5 w-3.5 text-primary" />
              </div>
              <span className="text-sm text-foreground/80">{text}</span>
            </div>
          ))}
          <div className="pt-1 border-t border-border/50">
            <div className="flex items-center gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted">
                <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <span className="text-xs text-muted-foreground">
                Read-only access — no transactions will be modified
              </span>
            </div>
          </div>
        </div>

        {/* Client info */}
        <p className="text-center text-xs text-muted-foreground/60 mb-5">
          Connecting from{" "}
          <span className="font-mono text-muted-foreground">
            {(() => { try { return new URL(redirectUri).hostname; } catch { return redirectUri; } })()}
          </span>
        </p>

        {error && (
          <div className="mb-4 rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="space-y-3">
          <button
            onClick={handleAllow}
            disabled={loading}
            className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Authorizing…</>
            ) : (
              "Allow Access"
            )}
          </button>
          <button
            onClick={handleDeny}
            disabled={loading}
            className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm font-medium text-foreground/70 transition-colors hover:bg-muted disabled:opacity-50"
          >
            Deny
          </button>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground/50">
          You can revoke access at any time from Settings → API Key.
        </p>
      </div>
    </div>
  );
}

export default function AuthorizePage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <AuthorizePageInner />
    </Suspense>
  );
}
