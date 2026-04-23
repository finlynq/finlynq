/**
 * Svix webhook signature verification — used by Resend Inbound.
 *
 * Spec: https://docs.svix.com/receiving/verifying-payloads/how-manual
 *
 * Payload to sign:  `${svix_id}.${svix_timestamp}.${body}`
 * Algorithm:        HMAC-SHA256 with the signing secret
 * Secret format:    `whsec_<base64>`  (the `whsec_` prefix is stripped before use)
 * Header format:    `v1,<base64(hmac)>`  (space-separated if multiple sigs — we accept any match)
 *
 * Timestamp tolerance: ±5 minutes, to prevent replay of old captures.
 *
 * This is hand-rolled rather than pulled from the `svix` npm package because:
 *   - The `svix` client pulls in a ton of transitive deps we don't need
 *   - The verification logic is ~20 lines of stdlib crypto
 *   - Easier to audit in one file than trust an opaque upstream
 */

import { createHmac, timingSafeEqual } from "crypto";

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function extractSvixHeaders(headers: Headers): SvixHeaders {
  return {
    id: headers.get("svix-id"),
    timestamp: headers.get("svix-timestamp"),
    signature: headers.get("svix-signature"),
  };
}

export class SvixVerifyError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "SvixVerifyError";
  }
}

/**
 * Verify a Svix webhook signature.
 *
 * @param rawBody  The request body as a UTF-8 string. Must be the raw body
 *                 — do NOT parse + re-stringify, whitespace changes will
 *                 break the HMAC. Grab it with `await request.text()` and
 *                 hand that string to both this verifier and any JSON parse
 *                 downstream.
 * @param headers  The svix-id / svix-timestamp / svix-signature headers.
 * @param secret   The signing secret from the Resend dashboard. Must start
 *                 with `whsec_`.
 *
 * Throws SvixVerifyError on any failure. Returns silently on success.
 *
 * Timing note: uses `timingSafeEqual` for the final compare to avoid signature
 * oracle attacks. The timestamp and header-presence checks happen before the
 * compare but take constant time relative to the attacker's input.
 */
export function verifySvixSignature(
  rawBody: string,
  headers: SvixHeaders,
  secret: string,
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    throw new SvixVerifyError("missing-headers");
  }

  // Reject if timestamp is outside ±5 minutes (replay protection).
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new SvixVerifyError("bad-timestamp");
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) {
    throw new SvixVerifyError("timestamp-out-of-range");
  }

  if (!secret.startsWith("whsec_")) {
    throw new SvixVerifyError("bad-secret-format");
  }
  const secretBytes = Buffer.from(secret.slice("whsec_".length), "base64");

  const signedPayload = `${id}.${ts}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes)
    .update(signedPayload, "utf8")
    .digest();

  // Header can contain multiple space-separated `v<version>,<sig>` entries;
  // any one matching is sufficient.
  const parts = signature.split(" ");
  for (const part of parts) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (provided.length !== expected.length) continue;
    if (timingSafeEqual(provided, expected)) return;
  }

  throw new SvixVerifyError("signature-mismatch");
}
