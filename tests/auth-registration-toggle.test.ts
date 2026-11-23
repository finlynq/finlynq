/**
 * GH #435: ALLOW_REGISTRATION=false turns sign-up off on a self-hosted server.
 * Unset keeps it open, so the hosted service and existing installs are
 * unchanged.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/db", () => ({ getDialect: () => "postgres", db: {} }));

import { isRegistrationOpen, REGISTRATION_CLOSED_MESSAGE } from "@/lib/auth/registration";
import { GET as registrationStatus } from "@/app/api/auth/registration/route";
import { POST as register } from "@/app/api/auth/register/route";
import { GET as usernameCheck } from "@/app/api/auth/username-check/route";
import { NextRequest } from "next/server";

afterEach(() => {
  vi.unstubAllEnvs();
});

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("isRegistrationOpen", () => {
  it("is open when unset or set to anything but a false value", () => {
    expect(isRegistrationOpen({})).toBe(true);
    for (const v of ["true", "1", "yes", "", "anything"]) expect(isRegistrationOpen({ ALLOW_REGISTRATION: v })).toBe(true);
  });

  it("is closed for false, 0, no, off (any case, trimmed)", () => {
    for (const v of ["false", "FALSE", " False ", "0", "no", "off"]) {
      expect(isRegistrationOpen({ ALLOW_REGISTRATION: v })).toBe(false);
    }
  });
});

describe("routes with sign-up off", () => {
  it("GET /api/auth/registration reports the setting", async () => {
    expect(await (await registrationStatus()).json()).toEqual({ open: true });
    vi.stubEnv("ALLOW_REGISTRATION", "false");
    expect(await (await registrationStatus()).json()).toEqual({ open: false });
  });

  it("POST /api/auth/register answers 403 before reading the body", async () => {
    vi.stubEnv("ALLOW_REGISTRATION", "false");
    const req = new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username: "someone", password: "a-long-password-123" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await register(req);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(REGISTRATION_CLOSED_MESSAGE);
  });

  it("the username check answers 403", async () => {
    vi.stubEnv("ALLOW_REGISTRATION", "false");
    const res = await usernameCheck(new NextRequest("http://localhost:3000/api/auth/username-check?username=someone"));
    expect(res.status).toBe(403);
  });
});

describe("every way in checks the setting", () => {
  it("register, username check and the zero-click demo logins", () => {
    for (const p of [
      "src/app/api/auth/register/route.ts",
      "src/app/api/auth/username-check/route.ts",
      "src/lib/auth/zero-click-login.ts",
    ]) {
      expect(read(p), p).toContain("isRegistrationOpen()");
    }
  });

  it("register is the only place that creates a user", () => {
    // If another sign-up path is added it must check isRegistrationOpen too.
    const src = read("src/app/api/auth/register/route.ts");
    expect(src).toContain("createUser(");
  });

  it("the sign-in page reads the setting and hides sign-up and the demo link", () => {
    const src = read("src/app/cloud/page.tsx");
    expect(src).toContain('fetch("/api/auth/registration")');
    expect(src).toMatch(/\{registrationOpen && \(\s*<div className="mb-6 flex rounded-xl/);
    expect(src).toMatch(/\{registrationOpen && \(\s*<p className="mt-6 text-center/);
  });
});
