"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

type AuthState = "loading" | "unauthenticated" | "locked" | "authenticated";

/** Re-check at most this often when the tab regains focus. */
const RECHECK_MIN_INTERVAL_MS = 30_000;

/**
 * Gate around authenticated app pages. If the session is valid we render
 * the children; otherwise we redirect to the login page.
 *
 * "Locked" is the third state (in-app feedback 2026-10-07): the sign-in is
 * still valid but the server no longer holds the session's data key — it
 * idles out of the DEK cache after 2h, and a process restart clears it too.
 * Read routes deliberately pass encrypted columns through rather than 423 the
 * page, so without this state the user got a working-looking page full of
 * `v1:` ciphertext, blank categories and single-letter account names. A fresh
 * sign-in restores the key, so that's what we ask for.
 *
 * Locked shows a prompt rather than auto-redirecting: login can, rarely,
 * complete without a key (a corrupt envelope), and an automatic redirect would
 * then bounce the user between this page and /cloud forever.
 *
 * The session is re-checked when the tab becomes visible or the window regains
 * focus, because the usual way to hit this is coming back to a tab left open
 * past the idle window — the initial mount check passed hours earlier.
 */
export function UnlockGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>("loading");
  const lastCheckRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const check = (initial: boolean) => {
      lastCheckRef.current = Date.now();
      fetch("/api/auth/session")
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (!data.authenticated) setState("unauthenticated");
          else setState(data.encryptionLocked ? "locked" : "authenticated");
        })
        .catch(() => {
          // A blip while re-checking (laptop waking, flaky Wi-Fi) must not
          // sign the user out; only the first check treats failure as
          // signed-out.
          if (initial && !cancelled) setState("unauthenticated");
        });
    };
    check(true);
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheckRef.current < RECHECK_MIN_INTERVAL_MS) return;
      check(false);
    };
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, []);

  if (state === "unauthenticated") {
    router.replace("/cloud");
  }

  if (state === "locked") {
    const here = `${window.location.pathname}${window.location.search}`;
    const signIn = `/cloud?locked=1&redirect=${encodeURIComponent(here)}`;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <h1 className="mb-2 text-lg font-semibold text-foreground">Session locked</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            For your security, your data was locked after a period of inactivity.
            Sign in again to unlock it.
          </p>
          <Button className="w-full" onClick={() => router.push(signIn)}>
            Sign in again
          </Button>
        </div>
      </div>
    );
  }

  if (state !== "authenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
      </div>
    );
  }

  return <>{children}</>;
}
