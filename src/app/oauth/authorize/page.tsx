"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  Database,
  Loader2,
  PencilLine,
  PiggyBank,
  TrendingUp,
} from "lucide-react";

// Authorized OAuth clients receive a Bearer token that exposes the full HTTP
// MCP tool surface — read AND write. The earlier copy claimed "Read-only
// access," which was inaccurate: every issued token can record transactions,
// approve staged imports, delete rules, etc. Real OAuth scope plumbing (so
// a client could request a read-only subset) is tracked as a follow-up; for
// this consent screen we tell the user the truth.
const PERMISSIONS = [
  { icon: Database, text: "Read accounts, balances, and transactions" },
  { icon: TrendingUp, text: "Read your portfolio and investment positions" },
  { icon: PiggyBank, text: "Read budgets, goals, and spending history" },
  { icon: PencilLine, text: "Create, edit, and delete transactions, rules, and goals" },
];

/**
 * Map known client_ids to human-readable names. Returns `null` when the id
 * is not in our well-known list — callers fall back to the registered
 * `client_name` from the DCR record (or, last resort, the raw `client_id`).
 */
function knownClientName(clientId: string): string | null {
  const known: Record<string, string> = {
    "claude.ai": "Claude",
    "claude-desktop": "Claude Desktop",
    "cursor": "Cursor",
    "cline": "Cline",
  };
  return known[clientId] ?? null;
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

  // Registered client metadata fetched from /api/oauth/client/[clientId].
  // We display the registered `client_name` (set by the client at DCR time)
  // alongside the redirect URI so the user can spot phishing clients whose
  // registered name doesn't match what they expected to authorize.
  type ClientMeta = { client_name: string; redirect_uris: string[] };
  const [clientMeta, setClientMeta] = useState<ClientMeta | null>(null);
  const [clientLookupError, setClientLookupError] = useState<string | null>(null);

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

  // Fetch the registered client metadata. We need this before the user clicks
  // Allow so the displayed name reflects what's actually in the DB.
  useEffect(() => {
    if (!clientId) return;
    fetch(`/api/oauth/client/${encodeURIComponent(clientId)}`)
      .then(async (r) => {
        if (r.status === 404) {
          setClientLookupError(
            "This OAuth client is not registered. Refusing to authorize."
          );
          return;
        }
        if (!r.ok) {
          setClientLookupError("Could not load client metadata.");
          return;
        }
        const data = (await r.json()) as ClientMeta;
        setClientMeta(data);
      })
      .catch(() => setClientLookupError("Could not load client metadata."));
  }, [clientId]);

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

  async function handleDeny() {
    setLoading(true);
    setError("");
    try {
      // Route through the server so the redirect_uri is validated against the
      // client's registered list. The client-side branch used to navigate
      // straight to whatever URI was in the query string, which let an
      // attacker craft an /oauth/authorize URL pointing at attacker.com,
      // wait for the user to click Deny, and exfil any state they could
      // chain into the URL. The server now refuses to redirect off-list.
      const res = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deny",
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.redirectTo) {
        setError(data.error_description ?? data.error ?? "Could not deny — invalid request");
        return;
      }
      window.location.href = data.redirectTo;
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
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

  // If the client lookup failed (unknown client_id), refuse to render the
  // consent UI at all — we don't want to display the raw redirect_uri from
  // the URL as if it were authorized. The user has no way to make a safe
  // decision when we can't even confirm the client is registered.
  if (clientLookupError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background bg-dot-pattern">
        <div className="mx-auto w-full max-w-md px-6 py-12 text-center space-y-4">
          <AlertTriangle className="h-12 w-12 text-amber-400 mx-auto" />
          <h1 className="text-xl font-bold text-foreground">Cannot Authorize</h1>
          <p className="text-sm text-muted-foreground">{clientLookupError}</p>
        </div>
      </div>
    );
  }

  // Wait for the client lookup to complete before rendering the consent
  // surface — otherwise the screen briefly shows the well-known mapping fall-
  // back, which is exactly the spoofable text we're trying to fix.
  if (!clientMeta) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Display order of preference:
  //   1. The well-known mapping (so "claude.ai" renders as "Claude").
  //   2. The DB-registered `client_name` from DCR — this is what the client
  //      told us about itself at registration time. The user should see it
  //      verbatim so they can spot phishing clients whose registered name
  //      doesn't match what they expected (e.g. "Cloude" or "Anthropic
  //      Helper").
  //   3. The raw `client_id` as a last resort.
  const wellKnown = knownClientName(clientId);
  const displayName = wellKnown ?? clientMeta.client_name ?? clientId;
  const showRegisteredName = !wellKnown && clientMeta.client_name && clientMeta.client_name !== clientId;

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
            Authorize <span className="text-primary">{displayName}</span>
          </h1>
          {showRegisteredName && (
            <p className="mt-2 text-xs text-muted-foreground">
              Registered as{" "}
              <span className="font-mono text-foreground">{clientMeta.client_name}</span>
            </p>
          )}
          <p className="mt-2 text-sm text-muted-foreground">
            {displayName} is requesting access to your Finlynq financial data.
          </p>
        </div>

        {/* Permissions list */}
        <div className="rounded-xl border border-border bg-card p-4 space-y-3 mb-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1">
            This will allow {displayName} to:
          </p>
          {PERMISSIONS.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Icon className="h-3.5 w-3.5 text-primary" />
              </div>
              <span className="text-sm text-foreground/80">{text}</span>
            </div>
          ))}
        </div>

        {/* Read AND write warning. The legacy "Read-only access" copy was
            inaccurate — every issued OAuth token can mutate the user's data
            until the connection is revoked. Real OAuth scope plumbing that
            lets a client request a read-only subset is tracked as a follow-up. */}
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 mb-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-xs text-foreground/80 leading-relaxed">
              {displayName} will be able to <strong>read AND write</strong> your
              financial data — including creating, editing, and deleting
              transactions — until you revoke the connection.
            </p>
          </div>
        </div>

        {/* Exact redirect URI in monospace so the user sees what they're
            actually authorizing. The hostname-only display in the prior
            version hid the path, which a phishing client can use to look
            harmless ("https://api.example.com/...") while the path goes
            somewhere unexpected. */}
        <div className="rounded-lg border border-border bg-card p-3 mb-5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-1">
            Authorization code will be sent to
          </p>
          <p className="text-xs font-mono text-foreground break-all">
            {redirectUri}
          </p>
        </div>

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
