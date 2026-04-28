import { type APIRequestContext } from "@playwright/test";

const PASSPHRASE = "TestPassword1234";

/**
 * Ensure the app is unlocked before running API tests.
 * Only calls unlock if actually needed.
 */
export async function ensureUnlocked(request: APIRequestContext) {
  const status = await request.get("/api/auth/unlock");
  const data = await status.json();
  if (data.unlocked) return;

  const res = await request.post("/api/auth/unlock", {
    data: { action: "unlock", passphrase: PASSPHRASE },
  });
  if (!res.ok()) {
    throw new Error(`Failed to unlock: ${res.status()} ${await res.text()}`);
  }
}

export { PASSPHRASE };
