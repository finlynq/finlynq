/**
 * Account logos (GH #420, 2026-11-20) — the ONE place that reads and writes
 * `account_logos`. SERVER ONLY.
 *
 * A logo is a small PNG the browser has already drawn onto a canvas (at most
 * 128x128, see components/accounts/logo-image.ts), whether the user uploaded
 * a file or Finlynq fetched the bank's icon. Storing only that canonical PNG
 * means no image library on the server and nothing but PNG ever served.
 *
 * The image (base64) and the domain it came from are encrypted with the
 * user's DEK, like account names: a logo says which bank an account is at.
 * Every query is owner-scoped; the account must belong to the user.
 */

import { and, eq } from "drizzle-orm";

import { db, schema } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";

/** Largest stored PNG. A 128x128 icon is typically 2-20 KB. */
export const MAX_LOGO_BYTES = 200 * 1024;
/** Largest accepted side, read from the PNG header. */
export const MAX_LOGO_SIDE = 256;

export type LogoSource = "upload" | "domain";

export class AccountLogoError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "AccountLogoError";
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decode a `data:image/png;base64,...` URL into PNG bytes, checking the
 * signature, the size and the dimensions in the IHDR chunk. Pure. Throws
 * AccountLogoError("invalid") with a reason the user can act on.
 */
export function decodeLogoDataUrl(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) throw new AccountLogoError("invalid", "The logo must be a PNG image.");
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new AccountLogoError("invalid", "That image is too large. Use one under 200 KB.");
  }
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    throw new AccountLogoError("invalid", "The logo must be a PNG image.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_LOGO_SIDE || height > MAX_LOGO_SIDE) {
    throw new AccountLogoError("invalid", `The logo must be at most ${MAX_LOGO_SIDE}x${MAX_LOGO_SIDE} pixels.`);
  }
  return bytes;
}

async function requireOwnedAccount(userId: string, accountId: number): Promise<void> {
  const row = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)))
    .get();
  if (!row) throw new AccountLogoError("not_found", "Account not found");
}

/** Save (or replace) an account's logo. Returns its new version (ms epoch). */
export async function saveAccountLogo(
  userId: string,
  dek: Buffer,
  accountId: number,
  png: Buffer,
  source: LogoSource,
  domain: string | null,
): Promise<number> {
  await requireOwnedAccount(userId, accountId);
  const imageCt = encryptField(dek, png.toString("base64"));
  if (!imageCt) throw new AccountLogoError("invalid", "Couldn't store that image.");
  const domainCt = domain ? encryptField(dek, domain) : null;
  const now = new Date();
  await db
    .insert(schema.accountLogos)
    .values({ accountId, userId, imageCt, domainCt, source, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.accountLogos.accountId,
      set: { imageCt, domainCt, source, updatedAt: now, userId },
    });
  return now.getTime();
}

/** The account's logo PNG and the domain it came from, or null (none, or unreadable with this key). */
export async function readAccountLogo(
  userId: string,
  dek: Buffer,
  accountId: number,
): Promise<{ png: Buffer; domain: string | null; source: LogoSource; version: number } | null> {
  const row = await db
    .select({
      imageCt: schema.accountLogos.imageCt,
      domainCt: schema.accountLogos.domainCt,
      source: schema.accountLogos.source,
      updatedAt: schema.accountLogos.updatedAt,
    })
    .from(schema.accountLogos)
    .where(and(eq(schema.accountLogos.accountId, accountId), eq(schema.accountLogos.userId, userId)))
    .get();
  if (!row) return null;
  const b64 = tryDecryptField(dek, row.imageCt, "account_logos.image_ct");
  if (!b64) return null;
  return {
    png: Buffer.from(b64, "base64"),
    domain: row.domainCt ? tryDecryptField(dek, row.domainCt, "account_logos.domain_ct") : null,
    source: row.source === "domain" ? "domain" : "upload",
    version: new Date(row.updatedAt).getTime(),
  };
}

export async function deleteAccountLogo(userId: string, accountId: number): Promise<boolean> {
  const gone = await db
    .delete(schema.accountLogos)
    .where(and(eq(schema.accountLogos.accountId, accountId), eq(schema.accountLogos.userId, userId)))
    .returning({ accountId: schema.accountLogos.accountId });
  return Array.isArray(gone) && gone.length > 0;
}

/** accountId -> version (ms epoch) for every account with a logo. DEK-free. */
export async function listLogoVersions(userId: string): Promise<Record<number, number>> {
  const rows = await db
    .select({ accountId: schema.accountLogos.accountId, updatedAt: schema.accountLogos.updatedAt })
    .from(schema.accountLogos)
    .where(eq(schema.accountLogos.userId, userId));
  const out: Record<number, number> = {};
  for (const r of rows) out[r.accountId] = new Date(r.updatedAt).getTime();
  return out;
}
