import { test, expect } from "@playwright/test";
import { PASSPHRASE } from "./helpers";

test.describe("Authentication & Unlock API", () => {
  test("GET /api/auth/unlock returns status fields", async ({ request }) => {
    const res = await request.get("/api/auth/unlock");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("needsSetup");
    expect(body).toHaveProperty("unlocked");
    expect(body).toHaveProperty("mode");
    expect(typeof body.needsSetup).toBe("boolean");
    expect(typeof body.unlocked).toBe("boolean");
  });

  test("POST unlock with correct passphrase succeeds", async ({ request }) => {
    const res = await request.post("/api/auth/unlock", {
      data: { action: "unlock", passphrase: PASSPHRASE },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("missing action defaults to unlock", async ({ request }) => {
    const res = await request.post("/api/auth/unlock", {
      data: { passphrase: PASSPHRASE },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test("invalid JSON body returns 400", async ({ request }) => {
    const res = await request.post("/api/auth/unlock", {
      headers: { "Content-Type": "application/json" },
      data: "not json{{{",
    });
    expect(res.status()).toBe(400);
  });
});
