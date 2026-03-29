import { describe, it, expect } from "vitest";
import { z, ZodError } from "zod";
import { validateBody, validateQuery, safeErrorMessage, safeRoute } from "@/lib/validate";

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

describe("safeErrorMessage", () => {
  it("returns error message for simple errors", () => {
    const err = new Error("Something went wrong");
    expect(safeErrorMessage(err, "Fallback")).toBe("Something went wrong");
  });

  it("strips file paths from error messages", () => {
    const err = new Error("Error at /home/user/src/file.ts:42");
    expect(safeErrorMessage(err, "Fallback")).toBe("Fallback");
  });

  it("strips .js file paths", () => {
    const err = new Error("Error in /app/server.js:10");
    expect(safeErrorMessage(err, "Fallback")).toBe("Fallback");
  });

  it("strips SQLITE errors", () => {
    const err = new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed");
    expect(safeErrorMessage(err, "Fallback")).toBe("Fallback");
  });

  it("strips stack traces", () => {
    const err = new Error("at Object.<anonymous> (/home/app.ts:1:1)");
    expect(safeErrorMessage(err, "Fallback")).toBe("Fallback");
  });

  it("strips long messages", () => {
    const err = new Error("a".repeat(201));
    expect(safeErrorMessage(err, "Fallback")).toBe("Fallback");
  });

  it("returns fallback for non-Error objects", () => {
    expect(safeErrorMessage("string error", "Fallback")).toBe("Fallback");
    expect(safeErrorMessage(42, "Fallback")).toBe("Fallback");
    expect(safeErrorMessage(null, "Fallback")).toBe("Fallback");
  });

  it("formats ZodError messages", () => {
    const zodErr = new ZodError([
      { code: "invalid_type", expected: "string", received: "number", path: ["name"], message: "Expected string" },
    ]);
    expect(safeErrorMessage(zodErr, "Fallback")).toBe("Expected string");
  });
});

describe("safeRoute", () => {
  it("returns handler result on success", async () => {
    const { NextResponse } = await import("next/server");
    const res = await safeRoute("Failed", () => NextResponse.json({ ok: true }));
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("catches errors and returns 500", async () => {
    const res = await safeRoute("Operation failed", () => {
      throw new Error("Unexpected");
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Unexpected");
  });

  it("uses fallback for unsafe errors", async () => {
    const res = await safeRoute("Operation failed", () => {
      throw new Error("Error at /src/lib/queries.ts:42");
    });
    const body = await res.json();
    expect(body.error).toBe("Operation failed");
  });
});
