// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeDbRows<T = Record<string, unknown>>(result: any): T[] {
  if (result && typeof result === "object") {
    if ("rows" in result && Array.isArray(result.rows)) return result.rows as T[];
    if (Array.isArray(result)) return result as T[];
  }
  return [];
}

/**
 * Extract the Postgres SQLSTATE code (e.g. "23503" for a foreign_key_violation)
 * from a caught error. Drizzle wraps every failed query in a `DrizzleQueryError`
 * whose message is `Failed query: ... params: ...` and attaches the ORIGINAL pg
 * error — the one that actually carries `.code` — on `.cause`. Checking only the
 * top-level `error.code` therefore misses it, so we look at both layers.
 * Returns `null` when no code is present.
 */
export function pgErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const top = (error as { code?: unknown }).code;
  if (typeof top === "string" && top) return top;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string" && causeCode) return causeCode;
  }
  return null;
}

/** True when a caught error is the given Postgres SQLSTATE code (Drizzle-wrapper aware). */
export function isPgErrorCode(error: unknown, code: string): boolean {
  return pgErrorCode(error) === code;
}
