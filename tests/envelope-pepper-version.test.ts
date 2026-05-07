/**
 * Pepper-version tests (Open #2 — pepper rotation).
 *
 * Validates:
 *  1. deriveKEK with version=1 reads PF_PEPPER (legacy default).
 *  2. deriveKEK with version=2 reads PF_PEPPER_V2.
 *  3. Same password + salt + DIFFERENT pepper version produces different KEKs.
 *  4. wrap/unwrap round-trip works with the same pepper version.
 *  5. unwrap with the wrong pepper version fails (auth-tag check).
 *  6. Unsupported pepper versions throw.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  deriveKEK,
  wrapDEK,
  unwrapDEK,
  generateDEK,
  generateSalt,
} from "@/lib/crypto/envelope";

const PASSWORD = "correct-horse-battery-staple-but-stronger";
const PEPPER_V1 = "v1-pepper-must-be-at-least-32-chars-long-yes";
const PEPPER_V2 = "v2-totally-different-pepper-also-32+chars-yes";

let originalPepper: string | undefined;
let originalPepperV2: string | undefined;
let originalNodeEnv: string | undefined;

beforeAll(() => {
  originalPepper = process.env.PF_PEPPER;
  originalPepperV2 = process.env.PF_PEPPER_V2;
  originalNodeEnv = process.env.NODE_ENV;
  // Set both peppers explicitly — Vitest leaves NODE_ENV='test' which means
  // getPepperForVersion takes the dev-fallback path on missing var. Setting
  // both explicitly ensures we exercise the production code path.
  process.env.PF_PEPPER = PEPPER_V1;
  process.env.PF_PEPPER_V2 = PEPPER_V2;
});

afterAll(() => {
  if (originalPepper === undefined) delete process.env.PF_PEPPER;
  else process.env.PF_PEPPER = originalPepper;
  if (originalPepperV2 === undefined) delete process.env.PF_PEPPER_V2;
  else process.env.PF_PEPPER_V2 = originalPepperV2;
  // NODE_ENV intentionally not touched (Next.js + Vitest treat it as
  // read-only build-time constant).
  void originalNodeEnv;
});

describe("deriveKEK — pepper version selection", () => {
  it("default (no version arg) reads PF_PEPPER (version 1)", () => {
    const salt = generateSalt();
    const kekDefault = deriveKEK(PASSWORD, salt);
    const kekV1 = deriveKEK(PASSWORD, salt, 1);
    expect(kekDefault.equals(kekV1)).toBe(true);
  });

  it("version 1 vs version 2 produce DIFFERENT KEKs from the same password+salt", () => {
    const salt = generateSalt();
    const kekV1 = deriveKEK(PASSWORD, salt, 1);
    const kekV2 = deriveKEK(PASSWORD, salt, 2);
    expect(kekV1.equals(kekV2)).toBe(false);
  });

  it("same password + same salt + same version => deterministic KEK", () => {
    const salt = generateSalt();
    const a = deriveKEK(PASSWORD, salt, 1);
    const b = deriveKEK(PASSWORD, salt, 1);
    expect(a.equals(b)).toBe(true);
  });

  it("rejects unsupported pepper versions", () => {
    expect(() => deriveKEK(PASSWORD, generateSalt(), 999)).toThrow(/pepper_version/);
    expect(() => deriveKEK(PASSWORD, generateSalt(), 0)).toThrow(/pepper_version/);
    expect(() => deriveKEK(PASSWORD, generateSalt(), -1)).toThrow(/pepper_version/);
  });
});

describe("wrap/unwrap round-trip — pepper version awareness", () => {
  it("v1-derived KEK wraps and v1-derived KEK unwraps cleanly", () => {
    const salt = generateSalt();
    const kek = deriveKEK(PASSWORD, salt, 1);
    const dek = generateDEK();
    const wrapped = wrapDEK(kek, dek, salt);
    const unwrapped = unwrapDEK(kek, wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("v2-derived KEK wraps and v2-derived KEK unwraps cleanly", () => {
    const salt = generateSalt();
    const kek = deriveKEK(PASSWORD, salt, 2);
    const dek = generateDEK();
    const wrapped = wrapDEK(kek, dek, salt);
    const unwrapped = unwrapDEK(kek, wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("v1-wrapped envelope FAILS to unwrap with a v2-derived KEK", () => {
    const salt = generateSalt();
    const dek = generateDEK();
    const kekV1 = deriveKEK(PASSWORD, salt, 1);
    const wrapped = wrapDEK(kekV1, dek, salt);
    const kekV2 = deriveKEK(PASSWORD, salt, 2);
    // AES-GCM auth-tag verification fires on wrong key.
    expect(() => unwrapDEK(kekV2, wrapped)).toThrow();
  });

  it("rotation flow: derive v1 KEK to unwrap, then wrap with v2 KEK, then unwrap with v2", () => {
    // This is exactly what the lazy login-time rewrap does.
    const salt = generateSalt();
    const dek = generateDEK();

    // Initial state: DEK wrapped under PF_PEPPER (v1).
    const kekV1 = deriveKEK(PASSWORD, salt, 1);
    const wrappedV1 = wrapDEK(kekV1, dek, salt);

    // Login at the moment PF_PEPPER_TARGET_VERSION=2 is set: server unwraps
    // with v1 (current row), then re-wraps with v2 (target).
    const recovered = unwrapDEK(kekV1, wrappedV1);
    const kekV2 = deriveKEK(PASSWORD, salt, 2);
    const wrappedV2 = wrapDEK(kekV2, recovered, salt);

    // Subsequent login: row is now pepper_version=2, decoder reads PF_PEPPER_V2.
    const finalDek = unwrapDEK(kekV2, wrappedV2);
    expect(finalDek.equals(dek)).toBe(true);
  });
});
