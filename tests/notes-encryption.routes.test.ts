/**
 * Phase 1 — REST note-encryption route tests.
 *
 * Asserts the write path encrypts the free-text note (value handed to
 * db.insert(...).values starts with `v1:`), the read path decrypts it, and a
 * cold DEK degrades to plaintext passthrough. Covers both the `note` column
 * (fx_overrides) and the `notes` column-name variant (subscriptions).
 *
 * See plan/encryption-plaintext-gaps.md Phase 1.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { TEST_DEK, mockAuthContext, createMockRequest, parseResponse } from "./helpers/api-test-utils";
import { encryptField } from "@/lib/crypto/envelope";

// ─── Configurable mock state ───────────────────────────────────────────────
let selectQueue: unknown[][] = []; // shifted per awaited SELECT / .all()
let getResult: unknown = { id: 1 };

const valuesSpy = vi.fn();
const setSpy = vi.fn();

const chain: Record<string, unknown> = {};
for (const m of ["select", "from", "where", "orderBy", "leftJoin", "limit", "offset", "insert", "update", "delete", "returning", "groupBy"]) {
  chain[m] = vi.fn(() => chain);
}
chain.values = vi.fn((arg: unknown) => { valuesSpy(arg); return chain; });
chain.set = vi.fn((arg: unknown) => { setSpy(arg); return chain; });
chain.all = vi.fn(() => (selectQueue.length ? selectQueue.shift() : []));
chain.get = vi.fn(() => getResult);
chain.run = vi.fn();
// Thenable — awaiting a SELECT chain shifts the next queued result set.
(chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
  resolve(selectQueue.length ? selectQueue.shift() : []);

vi.mock("@/db", () => ({
  db: new Proxy({}, { get: (_t, prop) => chain[prop as string] }),
  schema: new Proxy({}, {
    get: () => new Proxy({}, { get: (_t2, col) => ({ name: String(col) }) }),
  }),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), and: vi.fn(), desc: vi.fn(), asc: vi.fn(), sql: vi.fn(), inArray: vi.fn(),
}));

vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/verify-ownership", () => ({
  verifyOwnership: vi.fn(async () => {}),
  OwnershipError: class OwnershipError extends Error {},
}));
vi.mock("@/lib/require-dev-mode", () => ({ requireDevMode: vi.fn(async () => null) }));

import { requireAuth } from "@/lib/auth/require-auth";
import { GET as fxGET, POST as fxPOST } from "@/app/api/fx/overrides/route";
import { POST as subPOST } from "@/app/api/subscriptions/route";

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
  getResult = { id: 1 };
  (requireAuth as Mock).mockResolvedValue({ authenticated: true, context: mockAuthContext() });
});

describe("fx/overrides note encryption", () => {
  it("POST encrypts the note before insert", async () => {
    const req = createMockRequest("http://localhost:3000/api/fx/overrides", {
      method: "POST",
      body: { currency: "EUR", rateToUsd: 1.1, dateFrom: "2026-01-01", note: "wise rate" },
    });
    const res = await fxPOST(req);
    expect(res.status).toBe(201);
    const written = valuesSpy.mock.calls[0][0] as { note: string };
    expect(written.note).toMatch(/^v1:/);
    expect(written.note).not.toBe("wise rate");
  });

  it("GET decrypts the note", async () => {
    const ct = encryptField(TEST_DEK, "wise rate");
    selectQueue = [[{ id: 1, currency: "EUR", rateToUsd: 1.1, dateFrom: "2026-01-01", dateTo: null, note: ct }]];
    const req = createMockRequest("http://localhost:3000/api/fx/overrides");
    const res = await fxGET(req);
    const { status, data } = await parseResponse(res);
    expect(status).toBe(200);
    expect((data as { note: string }[])[0].note).toBe("wise rate");
  });

  it("POST under a cold DEK stores plaintext passthrough", async () => {
    (requireAuth as Mock).mockResolvedValue({ authenticated: true, context: mockAuthContext({ dek: null }) });
    const req = createMockRequest("http://localhost:3000/api/fx/overrides", {
      method: "POST",
      body: { currency: "EUR", rateToUsd: 1.1, dateFrom: "2026-01-01", note: "wise rate" },
    });
    const res = await fxPOST(req);
    expect(res.status).toBe(201);
    const written = valuesSpy.mock.calls[0][0] as { note: string };
    expect(written.note).toBe("wise rate");
  });
});

describe("subscriptions notes encryption (notes column variant)", () => {
  it("POST encrypts the notes column before insert", async () => {
    const req = createMockRequest("http://localhost:3000/api/subscriptions", {
      method: "POST",
      body: { name: "Netflix", amount: -15.99, notes: "shared family plan" },
    });
    const res = await subPOST(req);
    expect(res.status).toBe(201);
    const written = valuesSpy.mock.calls[0][0] as { notes: string };
    expect(written.notes).toMatch(/^v1:/);
    expect(written.notes).not.toBe("shared family plan");
  });

  // Review 2026-07-30 finding #7 — this used to assert a plaintext passthrough:
  // with a cold DEK the route wrote the notes UNENCRYPTED and, worse,
  // buildNameFields(null) returned {} so the subscription persisted with NULL
  // name_ct/name_lookup and was permanently nameless. The route now uses
  // requireEncryption, so the write is REFUSED with 423 instead.
  it("POST under a cold DEK is refused with 423 — nothing is written", async () => {
    (requireAuth as Mock).mockResolvedValue({ authenticated: true, context: mockAuthContext({ dek: null }) });
    const req = createMockRequest("http://localhost:3000/api/subscriptions", {
      method: "POST",
      body: { name: "Netflix", amount: -15.99, notes: "shared family plan" },
    });
    const res = await subPOST(req);
    expect(res.status).toBe(423);
    expect(valuesSpy).not.toHaveBeenCalled();
  });
});
