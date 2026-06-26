/**
 * apiHandler — one wrapper that folds the four concerns every mutating REST
 * route re-implements by hand (CODE_REVIEW.md §A4 / FINLYNQ-107):
 *
 *   1. auth gating          — `requireAuth` (401) or `requireEncryption` (423)
 *   2. body parse/validate  — `validateBody(json, schema)` → 400 on failure
 *   3. catch → status map    — optional `mapError` first (e.g. mapOperationError),
 *                              then `safeErrorMessage` + `logApiError`, honouring
 *                              `AppError.status` (vs a bare 500)
 *   4. success envelope     — `apiSuccess(value)` → `{ success: true, data }`
 *
 * ## Two output modes (the load-bearing knob)
 *
 * The `{ success: true, data }` envelope is the REST-side mirror of the MCP
 * `dataResponse` convention. But several route groups are consumed BARE by the
 * web + mobile clients (notably `/api/portfolio/operations/*`, whose mobile
 * `postPortfolioOperation` reads a bare `{ id, ... }` on 2xx and a bare
 * structured error on 4xx). Changing those shapes would blank client screens.
 *
 * So `apiHandler` supports a per-route opt-out:
 *
 *   - **enveloped (default)** — the handler returns a plain value; the wrapper
 *     wraps it with `apiSuccess`. Use this for NEW routes and route groups with
 *     no bare-shape consumer.
 *   - **raw / compat (`raw: true`)** — the handler returns its own
 *     `NextResponse` verbatim (the wrapper does NOT touch the success body).
 *     Use this to centralize auth + validation + error handling for a
 *     bare-shape route group WITHOUT changing the wire contract. The catch
 *     branch ALSO stays bare in raw mode (`{ error }`, not `{ success:false }`)
 *     so existing error consumers keep working.
 *
 * Behaviour preservation is mandatory: never flip a bare-shape route to the
 * envelope without checking its web + mobile consumers.
 */

import { NextRequest, NextResponse } from "next/server";
import type { ZodSchema, z } from "zod";
import { withOp } from "@/lib/diagnostics/op-context";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  validateBody,
  safeErrorMessage,
  logApiError,
  AppError,
} from "@/lib/validate";

/** Which auth gate runs before the handler. */
export type AuthMode = "auth" | "encryption";

/**
 * Context passed to the handler after auth (+ optional body validation) pass.
 *
 * `dek` is `Buffer` under `auth: "encryption"` (guaranteed by the 423 gate) and
 * `Buffer | null` under `auth: "auth"` (the request may be API-key auth with no
 * warm DEK). `body` is the parsed Zod output when a `body` schema is supplied,
 * else `undefined`.
 */
export interface ApiHandlerContext<B = undefined> {
  request: NextRequest;
  userId: string;
  dek: Buffer | null;
  sessionId: string | null;
  body: B;
}

export interface ApiHandlerOptions<S extends ZodSchema | undefined> {
  /** Auth gate. `"auth"` → 401 on failure; `"encryption"` → 423 if no DEK. */
  auth: AuthMode;
  /** When set, the request JSON body is parsed against this schema (400 on fail). */
  body?: S;
  /**
   * Compat mode. When `true` the handler returns its own `NextResponse` and the
   * wrapper passes both the success body AND the catch-branch error body through
   * bare (`{ error }`, not the `{ success, data }` / `{ success:false }`
   * envelope). Use ONLY for route groups with bare-shape web/mobile consumers.
   */
  raw?: boolean;
  /**
   * Optional domain-error → NextResponse mapper run FIRST in the catch branch
   * (e.g. `mapOperationError`). Return a `NextResponse` to short-circuit; return
   * `null` to fall through to the generic `safeErrorMessage` path.
   */
  mapError?: (err: unknown) => NextResponse | null;
  /** Fallback message for non-AppError throws (defaults to a generic string). */
  fallbackMessage?: string;
  /** Method + path used for `logApiError` (defaults to request method + pathname). */
  logPath?: string;
}

/** Handler return type: a plain value (enveloped/serialized) or a raw NextResponse. */
type HandlerReturn<R> = R | NextResponse | Promise<R | NextResponse>;

type InferBody<S extends ZodSchema | undefined> = S extends ZodSchema
  ? z.infer<S>
  : undefined;

/**
 * Wrap a route handler. Returns a `(request) => Promise<NextResponse>` function
 * suitable for `export const POST = apiHandler(...)`.
 */
export function apiHandler<R, S extends ZodSchema | undefined = undefined>(
  options: ApiHandlerOptions<S>,
  handler: (ctx: ApiHandlerContext<InferBody<S>>) => HandlerReturn<R>,
): (request: NextRequest) => Promise<NextResponse> {
  return (request: NextRequest): Promise<NextResponse> =>
    // Tag every query/error in this request with its route, and record the
    // request's wall-clock into the per-op rollup (diagnostics Phase 2).
    withOp(`${request.method} ${safePathname(request)}`, async (): Promise<NextResponse> => {
    // ── 1. auth gate ──────────────────────────────────────────────────────
    let userId: string;
    let dek: Buffer | null;
    let sessionId: string | null;
    if (options.auth === "encryption") {
      const enc = await requireEncryption(request);
      if (!enc.ok) return enc.response;
      userId = enc.userId;
      dek = enc.dek;
      sessionId = enc.sessionId;
    } else {
      const auth = await requireAuth(request);
      if (!auth.authenticated) return auth.response;
      userId = auth.context.userId;
      dek = auth.context.dek;
      sessionId = auth.context.sessionId;
    }

    const logPath =
      options.logPath ?? `${request.method} ${safePathname(request)}`;

    try {
      // ── 2. body parse/validate ──────────────────────────────────────────
      let body: InferBody<S> = undefined as InferBody<S>;
      if (options.body) {
        let json: unknown;
        try {
          json = await request.json();
        } catch {
          return errorResponse(options.raw, "Invalid JSON body", 400);
        }
        const parsed = validateBody(json, options.body);
        if (parsed.error) {
          // validateBody already emits a bare `{ error }` 400. Re-shape to the
          // envelope when NOT in raw mode so the contract stays uniform.
          if (options.raw) return parsed.error;
          const message = await readErrorMessage(parsed.error);
          return apiError(message, 400);
        }
        body = parsed.data as InferBody<S>;
      }

      // ── 3. handler ──────────────────────────────────────────────────────
      const result = await handler({ request, userId, dek, sessionId, body });

      // A handler that returns its own NextResponse is always passed through
      // verbatim — this is how raw-mode routes emit their bare success body,
      // and how any route can return a custom status / non-200 shape.
      if (result instanceof NextResponse) return result;

      // ── 4. success envelope ─────────────────────────────────────────────
      return apiSuccess(result);
    } catch (err: unknown) {
      // 4a. domain-error mapper (e.g. mapOperationError) wins first.
      const mapped = options.mapError?.(err) ?? null;
      if (mapped) return mapped;

      // 4b. generic path — honour AppError.status, else 500.
      await logApiError(
        request.method,
        safePathname(request),
        err,
        userId,
      );
      const status = err instanceof AppError ? err.status : 500;
      const message = safeErrorMessage(
        err,
        options.fallbackMessage ?? "Request failed",
      );
      void logPath; // logPath retained for callers that override; logApiError uses pathname.
      return errorResponse(options.raw, message, status);
    }
    });
}

/** Bare `{ error }` (raw/compat) vs `{ success:false, error }` (envelope). */
function errorResponse(
  raw: boolean | undefined,
  message: string,
  status: number,
): NextResponse {
  if (raw) {
    return NextResponse.json({ error: message }, { status });
  }
  return apiError(message, status);
}

/** Pull the `error` string out of a `validateBody` 400 NextResponse. */
async function readErrorMessage(res: NextResponse): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: string };
    return body.error ?? "Invalid request body";
  } catch {
    return "Invalid request body";
  }
}

/** Safe pathname extraction — `nextUrl` can throw on some synthetic requests. */
function safePathname(request: NextRequest): string {
  try {
    return request.nextUrl.pathname;
  } catch {
    try {
      return new URL(request.url).pathname;
    } catch {
      return "(unknown)";
    }
  }
}
