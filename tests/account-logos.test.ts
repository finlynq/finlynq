/**
 * GH #420 — account logos: the SSRF guard and format checks of the icon
 * fetcher, PNG validation, and the encrypted store (DB-gated).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  iconLinksFromHtml,
  isPublicAddress,
  normalizeInstitutionDomain,
  sniffImageMime,
} from "../src/lib/accounts/logo-fetch";
import {
  AccountLogoError,
  decodeLogoDataUrl,
  deleteAccountLogo,
  listLogoVersions,
  readAccountLogo,
  saveAccountLogo,
} from "../src/lib/accounts/logo-store";
import {
  TEST_DEK,
  bootstrapTestDb,
  resetTestDb,
  shutdownTestDb,
  createTestUser,
  createAccount,
} from "./helpers/portfolio-fixtures";
import { db } from "@/db";

const DB_URL = process.env.DATABASE_URL || process.env.PF_DATABASE_URL || "";
const HAS_TEST_DB = /\/[^/]*_test([?#]|$)/.test(DB_URL);
const describeDb = HAS_TEST_DB ? describe : describe.skip;

/** A minimal valid PNG header of the given size (enough for the checks). */
function pngOf(width: number, height: number, padTo = 64): Buffer {
  const b = Buffer.alloc(Math.max(33, padTo));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const dataUrl = (buf: Buffer) => `data:image/png;base64,${buf.toString("base64")}`;

describe("institution domain + address guard", () => {
  it("normalizes a pasted URL to its hostname", () => {
    expect(normalizeInstitutionDomain("https://www.ExampleBank.com/personal?x=1")).toBe("www.examplebank.com");
    expect(normalizeInstitutionDomain("examplebank.co.uk")).toBe("examplebank.co.uk");
    expect(normalizeInstitutionDomain(" td.com. ")).toBe("td.com");
  });
  it("refuses IPs, localhost, internal names, credentials and junk", () => {
    for (const bad of ["127.0.0.1", "http://10.0.0.5/x", "[::1]", "localhost", "intranet.local", "svc.internal", "user@bank.com", "no-dot", "a..b.com", "bank.123"]) {
      expect(normalizeInstitutionDomain(bad), bad).toBeNull();
    }
  });
  it("only public unicast addresses pass", () => {
    for (const ok of ["8.8.8.8", "142.250.72.14", "2606:4700:4700::1111"]) expect(isPublicAddress(ok), ok).toBe(true);
    for (const bad of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1", "not-an-ip"]) {
      expect(isPublicAddress(bad), bad).toBe(false);
    }
  });
});

describe("image format checks", () => {
  it("sniffs real image formats and refuses SVG/HTML", () => {
    expect(sniffImageMime(pngOf(16, 16))).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a....", "latin1"))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from("RIFF....WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe("image/x-icon");
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageMime(Buffer.from("<!doctype html><html>"))).toBeNull();
  });
  it("picks apple-touch-icon first, then the largest icon; drops svg, data and http links", () => {
    const html = `<head>
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel="icon" href="/favicon-192.png" sizes="192x192">
      <link rel="apple-touch-icon" href="https://cdn.examplebank.com/touch.png">
      <link rel="icon" href="/logo.svg">
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="icon" href="http://insecure.example/x.png">
      <link rel="stylesheet" href="/site.css">
    </head>`;
    expect(iconLinksFromHtml(html, "https://www.examplebank.com/")).toEqual([
      "https://cdn.examplebank.com/touch.png",
      "https://www.examplebank.com/favicon-192.png",
      "https://www.examplebank.com/favicon-32.png",
    ]);
  });
  it("accepts a small PNG data URL and refuses others", () => {
    expect(decodeLogoDataUrl(dataUrl(pngOf(128, 128))).length).toBeGreaterThan(0);
    expect(() => decodeLogoDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toThrow(AccountLogoError);
    expect(() => decodeLogoDataUrl(dataUrl(pngOf(1024, 1024)))).toThrow(/at most 256x256/);
    expect(() => decodeLogoDataUrl(dataUrl(Buffer.from("not a png at all, just text padding....")))).toThrow(/PNG/);
    expect(() => decodeLogoDataUrl(dataUrl(pngOf(64, 64, 300 * 1024)))).toThrow(/too large/);
  });
});

describeDb("account logo store", () => {
  let userId = "";
  let other = "";
  let accountId = 0;

  beforeAll(async () => {
    await bootstrapTestDb();
  });
  afterAll(async () => {
    await shutdownTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM account_logos`);
    userId = await createTestUser();
    other = await createTestUser();
    accountId = await createAccount({ userId, name: "Chequing", currency: "USD", type: "A", isInvestment: false });
  });

  it("round-trips the PNG, encrypted at rest, and lists its version", async () => {
    const png = pngOf(64, 64);
    const version = await saveAccountLogo(userId, TEST_DEK, accountId, png, "domain", "examplebank.com");
    const raw = await db.execute(sql`SELECT image_ct, domain_ct FROM account_logos WHERE account_id = ${accountId}`);
    const row = ((raw as unknown as { rows?: Array<{ image_ct: string; domain_ct: string }> }).rows ?? (raw as unknown as Array<{ image_ct: string; domain_ct: string }>))[0];
    expect(row.image_ct.startsWith("v1:")).toBe(true);
    expect(row.domain_ct.startsWith("v1:")).toBe(true);
    expect(row.domain_ct).not.toContain("examplebank");

    const back = await readAccountLogo(userId, TEST_DEK, accountId);
    expect(back?.png.equals(png)).toBe(true);
    expect(back).toMatchObject({ domain: "examplebank.com", source: "domain", version });
    expect(await listLogoVersions(userId)).toEqual({ [accountId]: version });
  });

  it("refuses another user's account and never reads across users", async () => {
    await expect(saveAccountLogo(other, TEST_DEK, accountId, pngOf(32, 32), "upload", null)).rejects.toThrow(/not found/);
    await saveAccountLogo(userId, TEST_DEK, accountId, pngOf(32, 32), "upload", null);
    expect(await readAccountLogo(other, TEST_DEK, accountId)).toBeNull();
    expect(await deleteAccountLogo(other, accountId)).toBe(false);
    expect(await listLogoVersions(other)).toEqual({});
  });

  it("replaces on save, deletes, and goes with its account", async () => {
    await saveAccountLogo(userId, TEST_DEK, accountId, pngOf(32, 32), "upload", null);
    await saveAccountLogo(userId, TEST_DEK, accountId, pngOf(48, 48), "upload", null);
    expect((await readAccountLogo(userId, TEST_DEK, accountId))?.png.readUInt32BE(16)).toBe(48);
    expect(await deleteAccountLogo(userId, accountId)).toBe(true);
    expect(await readAccountLogo(userId, TEST_DEK, accountId)).toBeNull();

    await saveAccountLogo(userId, TEST_DEK, accountId, pngOf(32, 32), "upload", null);
    await db.execute(sql`DELETE FROM accounts WHERE id = ${accountId}`);
    expect(await listLogoVersions(userId)).toEqual({});
  });
});
