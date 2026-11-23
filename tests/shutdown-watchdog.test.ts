/**
 * A stop signal is capped: Next's graceful stop waits on every running request
 * with no limit, and prod sat 90s (site down) until systemd SIGKILLed it.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  installShutdownWatchdog,
  summarizeActiveResources,
  SHUTDOWN_DEADLINE_MS,
} from "@/lib/shutdown-watchdog";

function fakeProcess(resources: string[] = []) {
  const em = new EventEmitter();
  const exit = vi.fn();
  return Object.assign(em, { exit, getActiveResourcesInfo: () => resources });
}

function fakeTimer() {
  const calls: { fn: () => void; ms: number; unref: ReturnType<typeof vi.fn> }[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const unref = vi.fn();
    calls.push({ fn, ms, unref });
    return { unref };
  };
  return { calls, setTimer };
}

describe("shutdown watchdog", () => {
  it("does nothing until a signal arrives", () => {
    const proc = fakeProcess();
    const t = fakeTimer();
    installShutdownWatchdog({ proc, setTimer: t.setTimer, log: () => {} });
    expect(t.calls).toHaveLength(0);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it("exits 143 after the deadline on SIGTERM, naming what was still open", () => {
    const proc = fakeProcess(["TCPSocketWrap", "Timeout", "TCPSocketWrap"]);
    const t = fakeTimer();
    const log = vi.fn();
    installShutdownWatchdog({ proc, setTimer: t.setTimer, log });
    proc.emit("SIGTERM", "SIGTERM");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].ms).toBe(SHUTDOWN_DEADLINE_MS);
    expect(t.calls[0].unref).toHaveBeenCalled();
    expect(proc.exit).not.toHaveBeenCalled();
    t.calls[0].fn();
    expect(proc.exit).toHaveBeenCalledWith(143);
    expect(log.mock.calls[0][0]).toContain("TCPSocketWrap x2, Timeout x1");
  });

  it("exits 130 on SIGINT and arms only once for repeated signals", () => {
    const proc = fakeProcess();
    const t = fakeTimer();
    installShutdownWatchdog({ proc, setTimer: t.setTimer, log: () => {} });
    proc.emit("SIGINT", "SIGINT");
    proc.emit("SIGTERM", "SIGTERM");
    proc.emit("SIGINT", "SIGINT");
    expect(t.calls).toHaveLength(1);
    t.calls[0].fn();
    expect(proc.exit).toHaveBeenCalledWith(130);
  });

  it("installs once per process", () => {
    const proc = fakeProcess();
    expect(installShutdownWatchdog({ proc, log: () => {} })).toBe(true);
    expect(installShutdownWatchdog({ proc, log: () => {} })).toBe(false);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
  });

  it("stays well inside systemd's 90s stop timeout", () => {
    expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(90_000);
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("summarizes resources by count", () => {
    expect(summarizeActiveResources([])).toBe("");
    expect(summarizeActiveResources(["A", "B", "B"])).toBe("B x2, A x1");
  });

  it("is installed at server boot, before the database setup", () => {
    const src = readFileSync(join(__dirname, "..", "src/instrumentation-node.ts"), "utf8");
    const watchdog = src.indexOf("installShutdownWatchdog()");
    expect(watchdog).toBeGreaterThan(-1);
    expect(watchdog).toBeLessThan(src.indexOf("const databaseUrl"));
  });
});
