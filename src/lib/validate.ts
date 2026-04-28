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
 * Sanitize an error for API responses — never leak stack traces, file paths, or SQL.
 */
export function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ZodError) {
    return error.issues.map((i) => i.message).join("; ");
  }
  if (error instanceof Error) {
    const msg = error.message;
    // Strip file paths, stack traces, SQL internals
    if (
      msg.includes("/") && msg.includes(".ts") ||
      msg.includes("/") && msg.includes(".js") ||
      msg.includes("SQLITE_") ||
      msg.includes("at ") && msg.includes("(") ||
      msg.length > 200
    ) {
      return fallback;
    }
    return msg;
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
