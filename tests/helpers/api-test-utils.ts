import { vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Create a mock NextRequest for API route testing.
 */
export function createMockRequest(
  url: string,
  options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): NextRequest {
  const init: RequestInit = {
    method: options?.method ?? "GET",
    headers: options?.headers ?? {},
  };
  if (options?.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { ...init.headers as Record<string, string>, "Content-Type": "application/json" };
  }
  return new NextRequest(new URL(url, "http://localhost:3000"), init as never);
}

/**
 * Extract JSON from NextResponse.
 */
export async function parseResponse(response: Response): Promise<{ status: number; data: unknown }> {
  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Create a chainable mock for Drizzle ORM query builder.
 * Supports: select().from().where().orderBy().groupBy().leftJoin().limit().offset().all().get().run()
 */
export function createDrizzleMock(returnValue: unknown = []) {
  const chain: Record<string, unknown> = {};
  const methods = ["select", "from", "where", "orderBy", "groupBy", "leftJoin", "limit", "offset", "values", "set", "returning"];
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.all = vi.fn().mockReturnValue(Array.isArray(returnValue) ? returnValue : []);
  chain.get = vi.fn().mockReturnValue(Array.isArray(returnValue) ? returnValue[0] : returnValue);
  chain.run = vi.fn().mockReturnValue(undefined);

  // insert/update/delete return the chain too
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.delete = vi.fn().mockReturnValue(chain);

  return chain;
}
