import { describe, it, expect, vi } from "vitest";

// Mock the database dependency before importing
vi.mock("@/db", () => ({
  db: {},
  schema: { transactions: { importHash: "importHash", fitId: "fitId" } },
}));
vi.mock("drizzle-orm", () => ({ inArray: vi.fn() }));

import { generateImportHash } from "@/lib/import-hash";

describe("generateImportHash", () => {
  it("returns a 32-char hex string (SHA-256 truncated)", () => {
    const hash = generateImportHash("2024-01-15", 1, 100.5, "Store");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic for same inputs", () => {
    const h1 = generateImportHash("2024-01-15", 1, 50.0, "Coffee");
    const h2 = generateImportHash("2024-01-15", 1, 50.0, "Coffee");
    expect(h1).toBe(h2);
  });

  it("changes when date differs", () => {
    const h1 = generateImportHash("2024-01-15", 1, 50.0, "Coffee");
    const h2 = generateImportHash("2024-01-16", 1, 50.0, "Coffee");
    expect(h1).not.toBe(h2);
  });

  it("changes when account differs", () => {
    const h1 = generateImportHash("2024-01-15", 1, 50.0, "Coffee");
    const h2 = generateImportHash("2024-01-15", 2, 50.0, "Coffee");
    expect(h1).not.toBe(h2);
  });

  it("changes when amount differs", () => {
    const h1 = generateImportHash("2024-01-15", 1, 50.0, "Coffee");
    const h2 = generateImportHash("2024-01-15", 1, 51.0, "Coffee");
    expect(h1).not.toBe(h2);
  });

  it("changes when payee differs", () => {
    const h1 = generateImportHash("2024-01-15", 1, 50.0, "Coffee");
    const h2 = generateImportHash("2024-01-15", 1, 50.0, "Tea");
    expect(h1).not.toBe(h2);
  });

  it("normalizes payee to lowercase", () => {
    const h1 = generateImportHash("2024-01-15", 1, 50.0, "Coffee Shop");
    const h2 = generateImportHash("2024-01-15", 1, 50.0, "coffee shop");
    expect(h1).toBe(h2);
  });

  it("handles empty payee", () => {
    const hash = generateImportHash("2024-01-15", 1, 50.0, "");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});
