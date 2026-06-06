import { describe, it, expect, afterEach } from "vitest";
import {
  importLocalpartPrefix,
  importAddressRegex,
} from "@/lib/email-import/import-address";

describe("import-address env prefix", () => {
  const orig = process.env.IMPORT_EMAIL_LOCALPART_PREFIX;
  afterEach(() => {
    if (orig === undefined) delete process.env.IMPORT_EMAIL_LOCALPART_PREFIX;
    else process.env.IMPORT_EMAIL_LOCALPART_PREFIX = orig;
  });

  it("defaults to import- (prod) and matches its own prefix only", () => {
    delete process.env.IMPORT_EMAIL_LOCALPART_PREFIX;
    expect(importLocalpartPrefix()).toBe("import-");
    const re = importAddressRegex();
    expect(re.test("import-966521837b16b31e9a6b307b6d2acde9")).toBe(true);
    expect(re.test("importdev-966521837b16b31e9a6b307b6d2acde9")).toBe(false);
    expect(re.test("import-notHEXatall")).toBe(false);
  });

  it("honors importdev- (dev) and rejects the prod prefix", () => {
    process.env.IMPORT_EMAIL_LOCALPART_PREFIX = "importdev-";
    expect(importLocalpartPrefix()).toBe("importdev-");
    const re = importAddressRegex();
    expect(re.test("importdev-966521837b16b31e9a6b307b6d2acde9")).toBe(true);
    expect(re.test("import-966521837b16b31e9a6b307b6d2acde9")).toBe(false);
  });

  it("accepts 8..64 hex tokens (legacy + current), rejects out of range / non-hex", () => {
    delete process.env.IMPORT_EMAIL_LOCALPART_PREFIX;
    const re = importAddressRegex();
    expect(re.test("import-deadbeef")).toBe(true); // 8 hex
    expect(re.test(`import-${"a".repeat(64)}`)).toBe(true); // 64 hex
    expect(re.test(`import-${"a".repeat(65)}`)).toBe(false); // >64
    expect(re.test("import-deadbee")).toBe(false); // 7 hex
    expect(re.test("import-DEADBEEF")).toBe(false); // uppercase
  });

  it("empty/whitespace-less env falls back to the default", () => {
    process.env.IMPORT_EMAIL_LOCALPART_PREFIX = "";
    expect(importLocalpartPrefix()).toBe("import-");
  });
});
