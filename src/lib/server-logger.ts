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

// Finding #12 — PII / secret scrubber. Applied to `message` and `stack`
// before we write or console.log anything. Catches obvious leaks that would
// otherwise end up in server logs + journald / Caddy logs.
//
// Patterns redact values following common secret keys (password, token,
// api_key, dek, pepper, mfa_secret, webhook_secret, etc.) and obvious
// token/key shapes (pf_..., pf_oauth_..., pf_refresh_..., long hex runs
// that look like secrets). Values get replaced with `<redacted>`.
const SECRET_KEY_PATTERN = /\b(password|passphrase|pass|token|api[-_]?key|dek|pepper|mfa[-_]?secret|webhook[-_]?secret|authorization|cookie|session|jti)\b\s*[:=]\s*["']?([^"'\s,}\]]+)/gi;
const PF_TOKEN_PATTERN = /\b(pf_(?:oauth_|refresh_)?[A-Za-z0-9]{32,})\b/g;
const LONG_HEX_PATTERN = /\b[a-f0-9]{48,}\b/gi; // 48+ hex chars (sha256+)
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function scrubSensitive(value: string): string {
  if (!value) return value;
  let out = value;
  // Redact secret-key assignments. Keep the key name visible for context.
  out = out.replace(SECRET_KEY_PATTERN, (_m, key) => `${key}=<redacted>`);
  // Redact any pf_ token shape regardless of context.
  out = out.replace(PF_TOKEN_PATTERN, "<redacted-pf-token>");
  // Redact long hex runs (likely secrets / hashes containing sensitive data).
  out = out.replace(LONG_HEX_PATTERN, "<redacted-hex>");
  // Redact emails — these are PII too.
  out = out.replace(EMAIL_PATTERN, "<redacted-email>");
  return out;
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

export { scrubSensitive };

export async function logServerError(
  method: string,
  path: string,
  status: number,
  error: unknown,
  userId?: string,
): Promise<void> {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawStack = error instanceof Error ? error.stack : undefined;
  const entry: ErrorLogEntry = {
    timestamp: new Date().toISOString(),
    level: status >= 500 ? "error" : "warn",
    method,
    path,
    status,
    userId,
    // Scrub before write — Finding #12. User IDs stay; tokens/secrets/emails
    // in free-form error text are redacted. See `scrubSensitive` above.
    message: scrubSensitive(rawMessage),
    stack: rawStack ? scrubSensitive(rawStack) : undefined,
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
