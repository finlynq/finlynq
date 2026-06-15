/**
 * FINLYNQ-162 — oversell guard pure helpers.
 *
 * Backs the web sell-form confirmation that warns (but never blocks) when a
 * sell quantity exceeds the current long position — selling more than held
 * opens a SHORT, a supported feature (`holding_lots.side`). These helpers
 * carry no business logic; the canonical sign-correct rows still come from
 * `src/lib/portfolio/operations.ts`.
 */
import { describe, it, expect } from "vitest";
import { isOversell, shortAmount } from "@/lib/portfolio/oversell";

describe("isOversell (FINLYNQ-162)", () => {
  it("is true when sell exceeds the long position", () => {
    expect(isOversell(150, 100)).toBe(true);
  });

  it("is false when sell equals the position (exact flatten)", () => {
    expect(isOversell(100, 100)).toBe(false);
  });

  it("is false when sell is within the position", () => {
    expect(isOversell(40, 100)).toBe(false);
  });

  it("is false for a non-positive sell qty", () => {
    expect(isOversell(0, 100)).toBe(false);
    expect(isOversell(-5, 100)).toBe(false);
  });

  it("does not warn when the position is already flat or short", () => {
    expect(isOversell(10, 0)).toBe(false);
    expect(isOversell(10, -25)).toBe(false);
  });

  it("is false for NaN / non-finite inputs (e.g. empty qty field)", () => {
    expect(isOversell(NaN, 100)).toBe(false);
    expect(isOversell(50, NaN)).toBe(false);
    expect(isOversell(Infinity, 100)).toBe(false);
  });

  it("handles fractional share quantities", () => {
    expect(isOversell(2.5, 2)).toBe(true);
    expect(isOversell(2, 2.5)).toBe(false);
  });
});

describe("shortAmount (FINLYNQ-162)", () => {
  it("returns the units of new short exposure on an oversell", () => {
    expect(shortAmount(150, 100)).toBe(50);
  });

  it("returns 0 when the sell is within the position", () => {
    expect(shortAmount(40, 100)).toBe(0);
    expect(shortAmount(100, 100)).toBe(0);
  });

  it("returns 0 when not an oversell (flat/short/NaN)", () => {
    expect(shortAmount(10, 0)).toBe(0);
    expect(shortAmount(NaN, 100)).toBe(0);
  });

  it("preserves fractional precision", () => {
    expect(shortAmount(2.5, 2)).toBeCloseTo(0.5, 10);
  });
});
