import { describe, it, expect } from "vitest";
import { z, ZodError } from "zod";
import { validateBody, validateQuery, safeErrorMessage, safeRoute, AppError } from "@/lib/validate";

describe("validateBody", () => {
  const schema = z.object({
    name: z.string(),
    age: z.number().min(0),
  });

  it("returns data on valid input", () => {
    const result = validateBody({ name: "Alice", age: 30 }, schema);
    expect(result.data).toEqual({ name: "Alice", age: 30 });
    expect(result.error).toBeUndefined();
  });

  it("returns error response on invalid input", async () => {
    const result = validateBody({ name: 123 }, schema);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error!.status).toBe(400);
    const body = await result.error!.json();
    expect(body.error).toBeDefined();
  });

  it("joins multiple error messages", async () => {
    const result = validateBody({}, schema);
    const body = await result.error!.json();
    expect(body.error).toContain(";");
  });

  it("handles optional fields", () => {
    const optSchema = z.object({ name: z.string(), note: z.string().optional() });
    const result = validateBody({ name: "Test" }, optSchema);
    expect(result.data).toEqual({ name: "Test" });
  });
});

describe("validateQuery", () => {
  const schema = z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
  });

  it("returns data on valid params", () => {
    const result = validateQuery({ page: "1", limit: "10" }, schema);
    expect(result.data).toEqual({ page: "1", limit: "10" });
  });

  it("handles null values as validation error", () => {
    const result = validateQuery({ page: null, limit: null }, schema);
    // null is not a valid string — Zod rejects it
    expect(result.error).toBeDefined();
  });
});

describe("safeErrorMessage (M-18 allowlist)", () => {
  // Allowlist behavior: only ZodError and AppError pass through. Plain
  // `Error` returns the fallback regardless of message content.
  it("returns fallback for plain Error (allowlist)", () => {
    const err = new Error("Something went wrong");
    expect(safeErrorMessage(err, "Fallback")).toBe("Fallback");
  });

  it("returns fallback for messages containing file paths", () => {
    const err = new Error("Error at /home/user/src/file.ts:42");
    expect(safeErrorMessage(err, "Fallback")).toBe("Fallback");
  });

  it("returns fallback for SQL/Postgres internals", () => {
    expect(
      safeErrorMessage(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed"), "Fallback")
    ).toBe("Fallback");
    // Postgres error formats that the previous denylist heuristic missed:
    expect(safeErrorMessage(new Error("connect ECONNREFUSED 127.0.0.1:5432"), "Fallback")).toBe(
      "Fallback"
    );
    expect(
      safeErrorMessage(new Error('relation "mystery_table" does not exist'), "Fallback")
    ).toBe("Fallback");
  });

  it("returns fallback for stack-trace-like messages", () => {
    const err = new Error("at Object.<anonymous> (/home/app.ts:1:1)");
    expect(safeErrorMessage(err, "Fallback")).toBe("Fallback");
  });

  it("returns fallback for non-Error objects", () => {
    expect(safeErrorMessage("string error", "Fallback")).toBe("Fallback");
    expect(safeErrorMessage(42, "Fallback")).toBe("Fallback");
    expect(safeErrorMessage(null, "Fallback")).toBe("Fallback");
  });

  it("passes through AppError messages (allowlist)", () => {
    const err = new AppError("Account not owned by user");
    expect(safeErrorMessage(err, "Fallback")).toBe("Account not owned by user");
  });

  it("passes through duck-typed AppError across module boundaries", () => {
    // Simulates an AppError thrown from a different module instance
    // (HMR / ESM dual loading), where `instanceof` would fail.
    const ducked = {
      name: "AppError",
      message: "duck-typed app error",
      [Symbol.for("finlynq.AppError")]: true,
    };
    expect(safeErrorMessage(ducked, "Fallback")).toBe("duck-typed app error");
  });

  it("formats ZodError messages", () => {
    const zodErr = new ZodError([
      { code: "invalid_type", expected: "string", input: 0, path: ["name"], message: "Expected string" },
    ]);
    expect(safeErrorMessage(zodErr, "Fallback")).toBe("Expected string");
  });

  it("passes through ZodError-shaped objects across module instances", () => {
    // workspace + nested package can ship two zod copies — duck-type fallback
    const ducked = {
      name: "ZodError",
      issues: [{ message: "Expected string" }, { message: "must be > 0" }],
    };
    expect(safeErrorMessage(ducked, "Fallback")).toBe("Expected string; must be > 0");
  });
});

describe("safeRoute", () => {
  it("returns handler result on success", async () => {
    const { NextResponse } = await import("next/server");
    const res = await safeRoute("Failed", () => NextResponse.json({ ok: true }));
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns fallback for plain Error (allowlist)", async () => {
    const res = await safeRoute("Operation failed", () => {
      throw new Error("Unexpected");
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Operation failed");
  });

  it("uses fallback for messages with file paths", async () => {
    const res = await safeRoute("Operation failed", () => {
      throw new Error("Error at /src/lib/queries.ts:42");
    });
    const body = await res.json();
    expect(body.error).toBe("Operation failed");
  });

  it("passes through AppError to caller", async () => {
    const res = await safeRoute("Operation failed", () => {
      throw new AppError("Insufficient balance");
    });
    const body = await res.json();
    expect(body.error).toBe("Insufficient balance");
  });
});
