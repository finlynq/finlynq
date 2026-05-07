import { NextResponse } from "next/server";
import { z, ZodError, ZodSchema } from "zod";

/**
 * Parse a request body against a Zod schema.
 * Returns { data } on success, { error: NextResponse } on failure.
 */
export function validateBody<T extends ZodSchema>(
  body: unknown,
  schema: T
): { data: z.infer<T>; error?: never } | { data?: never; error: NextResponse } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { data: result.data };
  }
  const message = result.error.issues.map((i) => i.message).join("; ");
  return {
    error: NextResponse.json({ error: message }, { status: 400 }),
  };
}

/**
 * Parse query params (as plain object) against a Zod schema.
 */
export function validateQuery<T extends ZodSchema>(
  params: Record<string, string | null>,
  schema: T
): { data: z.infer<T>; error?: never } | { data?: never; error: NextResponse } {
  const result = schema.safeParse(params);
  if (result.success) {
    return { data: result.data };
  }
  const message = result.error.issues.map((i) => i.message).join("; ");
  return {
    error: NextResponse.json({ error: message }, { status: 400 }),
  };
}

/**
 * Marker class for *intentionally user-visible* business errors.
 *
 * `safeErrorMessage` only passes through messages from `AppError`,
 * `ZodError`, and `AppError`-marked subclasses (via the `isAppError`
 * symbol — works across module-instance boundaries from HMR / ESM dual
 * loading). Anything else returns a generic fallback. This is the
 * allowlist version of the previous denylist (which missed
 * "ECONNREFUSED", `relation "..." does not exist`, etc.).
 *
 * To return a specific message to the API caller from a route or helper,
 * throw `new AppError("Insufficient balance")` instead of `new Error(...)`.
 *
 * For migration: existing `throw new Error(...)` callsites continue to
 * work, but their messages are now hidden behind the fallback. Convert
 * the user-meaningful ones to `AppError` as routes are touched.
 */
const APP_ERROR_BRAND = Symbol.for("finlynq.AppError");

export class AppError extends Error {
  /** Marker that survives cross-module-instance `instanceof` failures. */
  readonly [APP_ERROR_BRAND] = true;
  /** Optional HTTP status hint. Routes are free to ignore. */
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

function isAppError(err: unknown): err is AppError {
  if (err instanceof AppError) return true;
  // HMR / dual-bundling escape hatch — `instanceof` can lie if the class
  // was loaded from two module instances. The branded symbol is the
  // robust check.
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[APP_ERROR_BRAND] === true
  );
}

/**
 * Sanitize an error for API responses.
 *
 * Allowlist:
 *   - `ZodError` (validation messages are user-meaningful by design)
 *   - `AppError` (business errors, marked intentionally user-visible)
 *
 * Everything else returns the supplied `fallback` string. The previous
 * denylist heuristic (filter by ".ts" / ".js" / "SQLITE_" / "at (" /
 * length>200) missed Postgres errors like "ECONNREFUSED", relation
 * "..." does not exist, and bcrypt internals.
 */
export function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ZodError) {
    return error.issues.map((i) => i.message).join("; ");
  }
  // ZodError can also arrive from a different `zod` module instance
  // (workspace + nested package) and miss the `instanceof` check; fall
  // back to the duck-type identifier exposed by every Zod version.
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  ) {
    const issues = (error as { issues: { message?: string }[] }).issues;
    return issues.map((i) => i.message ?? "").filter(Boolean).join("; ");
  }
  if (isAppError(error)) {
    return error.message;
  }
  return fallback;
}

/**
 * Log an API error to the server log file for monitoring.
 * Call this in catch blocks to ensure errors are tracked.
 */
export async function logApiError(
  method: string,
  path: string,
  error: unknown,
  userId?: string,
): Promise<void> {
  try {
    const { logServerError } = await import("@/lib/server-logger");
    await logServerError(method, path, 500, error, userId);
  } catch {
    // Fallback: at least print to console
    console.error(`[API Error] ${method} ${path}:`, error);
  }
}

/**
 * Wrap a route handler with safe error handling.
 */
export function safeRoute(fallbackMessage: string, handler: () => NextResponse | Promise<NextResponse>): Promise<NextResponse> {
  return Promise.resolve()
    .then(() => handler())
    .catch((error: unknown) => {
      const message = safeErrorMessage(error, fallbackMessage);
      return NextResponse.json({ error: message }, { status: 500 });
    });
}
