/**
 * Server-side error logger for monitoring API errors.
 *
 * Logs errors with structured context (endpoint, method, user, timestamp)
 * to both console and a rotating log file for post-mortem analysis.
 */

import { appendFile } from "fs/promises";
import { join } from "path";

const LOG_FILE = join(process.cwd(), "pf-server.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB — rotate when exceeded

interface ErrorLogEntry {
  timestamp: string;
  level: "error" | "warn" | "info";
  method: string;
  path: string;
  status: number;
  userId?: string;
  message: string;
  stack?: string;
}

function formatEntry(entry: ErrorLogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    entry.level.toUpperCase(),
    `${entry.method} ${entry.path}`,
    `→ ${entry.status}`,
    entry.userId ? `user=${entry.userId}` : "",
    entry.message,
  ].filter(Boolean);
  return parts.join(" ");
}

export async function logServerError(
  method: string,
  path: string,
  status: number,
  error: unknown,
  userId?: string,
): Promise<void> {
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    level: status >= 500 ? "error" : "warn",
    method,
    path,
    status,
    userId,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };

  // Always log to console
  const line = formatEntry(entry);
  if (status >= 500) {
    console.error(line);
    if (entry.stack) console.error(entry.stack);
  } else {
    console.warn(line);
  }

  // Append to log file (best-effort, never throw)
  try {
    const logLine = JSON.stringify(entry) + "\n";
    await appendFile(LOG_FILE, logLine);

    // Check size for rotation
    const { stat } = await import("fs/promises");
    const info = await stat(LOG_FILE);
    if (info.size > MAX_LOG_SIZE) {
      const { rename, unlink } = await import("fs/promises");
      const rotated = LOG_FILE + ".1";
      try { await unlink(rotated); } catch { /* ignore */ }
      await rename(LOG_FILE, rotated);
    }
  } catch {
    // Log file write failure is non-critical
  }
}
