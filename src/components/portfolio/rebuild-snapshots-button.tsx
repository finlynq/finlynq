"use client";

/**
 * Rebuild investment history button — triggers a re-materialize of the user's
 * daily `portfolio_snapshots` from their first transaction to today. Used by
 * the Settings → Investments card AND the net-worth chart's empty-state.
 *
 * The nightly snapshot cron is forward-only, so a back-dated investment edit
 * leaves history stale until either the auto-rebuild drain cron catches up or
 * the user clicks this. Idempotent on the snapshot unique index — safe to
 * re-run.
 *
 * FINLYNQ-205 — the rebuild now runs server-side (POST returns 202 and the walk
 * runs fire-and-forget into a `globalThis` per-user progress registry). This
 * component:
 *   - polls `GET /api/portfolio/snapshots/rebuild/status` on mount, so a reload
 *     mid-rebuild re-attaches to the in-flight run instead of reverting to idle,
 *   - shows an unmistakable in-progress panel with a determinate "Processing day
 *     X of Y" count + progress bar (indeterminate until the first day lands),
 *   - is consistent across both mount points (the logic lives entirely here),
 *   - clears to a "Rebuilt N days" summary on completion.
 *
 * plan/net-worth-over-time.md Part B.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

type Variant = "default" | "outline" | "secondary" | "ghost";
type Size = "sm" | "default" | "lg";

interface RebuildStatus {
  running: boolean;
  daysProcessed: number;
  totalDays: number;
  lastResult: { daysProcessed: number; gapsFilledDays: number } | null;
  error: string | null;
}

const POLL_MS = 1500;

function summaryText(daysProcessed: number, gapsFilledDays: number): string {
  const days = daysProcessed ?? 0;
  const gaps = gapsFilledDays ?? 0;
  return `Rebuilt ${days} day${days === 1 ? "" : "s"}${gaps ? `, ${gaps} with gap-fills` : ""}.`;
}

export function RebuildSnapshotsButton({
  onDone,
  variant = "outline",
  size = "sm",
  label = "Rebuild investment history",
}: {
  onDone?: () => void;
  variant?: Variant;
  size?: Size;
  label?: string;
}) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const wasRunning = useRef(false);
  const onDoneRef = useRef(onDone);
  // Held in a ref so the recursive poll loop can call the latest closure without
  // a self-referencing useCallback (which trips react-hooks immutability).
  const scheduleRef = useRef<() => void>(() => {});

  // Keep latest onDone in a ref (refs must be written in effects, not render).
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // Single status fetch — updates UI state from the server-side registry.
  // Returns whether a rebuild is still running so the poll loop can reschedule.
  const fetchStatus = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/portfolio/snapshots/rebuild/status", {
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) return false;
      const s: RebuildStatus = await res.json();
      if (!mounted.current) return s.running;

      if (s.running) {
        wasRunning.current = true;
        setStatus("running");
        setProgress({ done: s.daysProcessed ?? 0, total: s.totalDays ?? 0 });
        setMsg("");
        return true;
      }

      // Not running. If we just watched a run finish, surface its terminal state.
      if (wasRunning.current) {
        wasRunning.current = false;
        if (s.error) {
          setStatus("error");
          setMsg(s.error);
        } else if (s.lastResult) {
          setStatus("done");
          setMsg(summaryText(s.lastResult.daysProcessed, s.lastResult.gapsFilledDays));
          onDoneRef.current?.();
        } else {
          setStatus("idle");
        }
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const scheduleNextPoll = useCallback(() => {
    stopPolling();
    pollTimer.current = setTimeout(async () => {
      const stillRunning = await fetchStatus();
      if (stillRunning && mounted.current) scheduleRef.current();
    }, POLL_MS);
  }, [fetchStatus, stopPolling]);

  // Keep the recursive-poll ref pointing at the latest closure (in an effect, so
  // we never write a ref during render).
  useEffect(() => {
    scheduleRef.current = scheduleNextPoll;
  }, [scheduleNextPoll]);

  // On mount: detect an already-running rebuild (survives reload) and, if found,
  // re-attach to it and start polling.
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const running = await fetchStatus();
      if (running && mounted.current) scheduleRef.current();
    })();
    return () => {
      mounted.current = false;
      stopPolling();
    };
  }, [fetchStatus, stopPolling]);

  async function run() {
    if (status === "running") return;
    setStatus("running");
    setMsg("");
    setProgress({ done: 0, total: 0 });
    wasRunning.current = true;
    try {
      const res = await fetch("/api/portfolio/snapshots/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // 202 = started; 409 = already running (a concurrent rebuild — still poll).
      if (!res.ok && res.status !== 409) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? "Rebuild failed");
      }
      // Kick off polling immediately; the status route reflects the live walk.
      void fetchStatus().then((running) => {
        if (running && mounted.current) scheduleNextPoll();
      });
    } catch (e) {
      wasRunning.current = false;
      setStatus("error");
      setMsg(e instanceof Error ? e.message : "Rebuild failed");
    }
  }

  const isRunning = status === "running";
  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const indeterminate = isRunning && progress.total === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={variant} size={size} onClick={run} disabled={isRunning}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRunning ? "animate-spin" : ""}`} />
          {isRunning ? "Rebuilding…" : label}
        </Button>
        {msg && !isRunning && (
          <span
            className={`text-xs ${status === "error" ? "text-rose-600" : "text-muted-foreground"}`}
          >
            {msg}
          </span>
        )}
      </div>

      {/* Unmistakable in-progress panel with a determinate day count + bar. */}
      {isRunning && (
        <div
          className="w-full max-w-sm rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2.5 dark:border-indigo-900/50 dark:bg-indigo-950/30"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300">
              Rebuilding investment history…
            </span>
            <span className="text-[11px] tabular-nums text-indigo-600/80 dark:text-indigo-400/80">
              {indeterminate
                ? "starting…"
                : `Processing day ${progress.done} of ${progress.total}`}
            </span>
          </div>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-indigo-200/70 dark:bg-indigo-900/60"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : pct}
            aria-label="Rebuild progress"
          >
            <div
              className={`h-full rounded-full bg-indigo-600 transition-[width] duration-500 ease-out ${
                indeterminate ? "w-1/3 animate-pulse" : ""
              }`}
              style={indeterminate ? undefined : { width: `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            This can take up to a minute. You can leave this page; it keeps running.
          </p>
        </div>
      )}
    </div>
  );
}
