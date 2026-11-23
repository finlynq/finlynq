/**
 * A taken goal name answers 409, not 500 (prod diagnostics_log 2026-11-22
 * 06:35: `goals_user_name_lookup_uniq` surfaced as a raw "Failed").
 *
 * The write itself is mocked to throw the violation the way Drizzle rethrows
 * it (a "Failed query" wrapper whose `.cause` is the pg error), so this pins
 * only the route's error mapping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: "23505",
    constraint,
  });
}
function drizzleWrapped(constraint: string): Error {
  return Object.assign(new Error('Failed query: insert into "goals" (...) values (...)'), {
    cause: uniqueViolation(constraint),
  });
}

const txError: { current: Error | null } = { current: null };

vi.mock("@/db", () => ({
  db: {},
  schema: { goals: {}, accounts: {}, goalAccounts: {} },
  withDbTransaction: vi.fn(async () => {
    throw txError.current;
  }),
}));

vi.mock("@/lib/auth/require-encryption", () => ({
  requireEncryption: vi.fn(async () => ({ ok: true, userId: "u1", dek: Buffer.alloc(32, 0xaa) })),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/fx-service", () => ({
  getDisplayCurrency: vi.fn(async () => "USD"),
  getRateMap: vi.fn(async () => new Map()),
  convertWithRateMap: vi.fn((n: number) => n),
}));
vi.mock("@/lib/crypto/encrypted-columns", () => ({
  buildNameFields: vi.fn(() => ({ nameCt: "v1:x", nameLookup: "lookup" })),
  decryptNamedRows: vi.fn((rows: unknown[]) => rows),
  encryptOptional: vi.fn(() => null),
  decryptOptional: vi.fn(() => null),
}));

import { POST } from "@/app/api/goals/route";
import { createMockRequest, parseResponse } from "../helpers/api-test-utils";

const body = { name: "Emergency fund", type: "savings", targetAmount: 1000 };

describe("POST /api/goals duplicate name", () => {
  beforeEach(() => {
    txError.current = null;
  });

  it("returns 409 when the name is already taken", async () => {
    txError.current = drizzleWrapped("goals_user_name_lookup_uniq");
    const res = await POST(createMockRequest("http://localhost:3000/api/goals", { method: "POST", body }));
    const { status, data } = await parseResponse(res);
    expect(status).toBe(409);
    expect((data as { error: string }).error).toMatch(/already exists/);
  });

  it("another unique violation stays a 500", async () => {
    txError.current = drizzleWrapped("some_other_uniq");
    const res = await POST(createMockRequest("http://localhost:3000/api/goals", { method: "POST", body }));
    const { status } = await parseResponse(res);
    expect(status).toBe(500);
  });
});
