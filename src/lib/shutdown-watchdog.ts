/**
 * Caps how long a stop signal can take (2026-11-23).
 *
 * On SIGTERM, Next's standalone server stops accepting connections and then
 * waits for every request already running to finish, with no limit
 * (node_modules/next/dist/server/lib/start-server.js, `cleanup`). One request
 * that stays open (a slow client, a long call) therefore holds the stop until
 * systemd gives up after 90s and SIGKILLs the process. Prod hit this on
 * 2026-11-20 16:03 and 2026-11-23 03:49: each deploy waited the full 90s, and
 * since the old server no longer accepted connections, the site was down for
 * all of it.
 *
 * This leaves Next's own graceful stop alone (it still runs and normally exits
 * in well under a second) and only adds a deadline: if the process is still
 * alive `timeoutMs` after the first signal, it logs what was still open and
 * exits with the same code Next uses (143 for SIGTERM, 130 for SIGINT).
 * Writes that must be all-or-nothing already run in one transaction, which
 * Postgres rolls back when the connection drops, exactly as on a SIGKILL.
 */

export const SHUTDOWN_DEADLINE_MS = 20_000;

type Signal = "SIGTERM" | "SIGINT";

export interface WatchdogProcess {
  on(event: Signal, listener: (signal: Signal) => void): unknown;
  exit(code: number): never | void;
  getActiveResourcesInfo?: () => string[];
}

export interface WatchdogOptions {
  proc?: WatchdogProcess;
  timeoutMs?: number;
  log?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
}

/** "TCPSocketWrap x3, Timeout x2": what kept the event loop busy. */
export function summarizeActiveResources(list: string[]): string {
  const counts = new Map<string, number>();
  for (const name of list) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} x${n}`)
    .join(", ");
}

const INSTALLED = Symbol.for("pf.shutdownWatchdogInstalled");

export function installShutdownWatchdog(opts: WatchdogOptions = {}): boolean {
  const proc = opts.proc ?? (process as unknown as WatchdogProcess);
  const timeoutMs = opts.timeoutMs ?? SHUTDOWN_DEADLINE_MS;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

  // Once per process (HMR / a second register call must not stack listeners).
  const holder = proc as unknown as Record<symbol, boolean>;
  if (holder[INSTALLED]) return false;
  holder[INSTALLED] = true;

  let armed = false;
  const onSignal = (signal: Signal) => {
    if (armed) return;
    armed = true;
    const timer = setTimer(() => {
      const open = proc.getActiveResourcesInfo
        ? summarizeActiveResources(proc.getActiveResourcesInfo())
        : "unknown";
      log(
        `[shutdown] ${signal}: requests still running after ${Math.round(
          timeoutMs / 1000,
        )}s, exiting anyway (still open: ${open || "nothing"})`,
      );
      proc.exit(signal === "SIGINT" ? 130 : 143);
    }, timeoutMs);
    // Never keep the process alive just for the deadline.
    timer.unref?.();
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);
  return true;
}
