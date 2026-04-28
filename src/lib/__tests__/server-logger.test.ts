import { describe, it, expect } from "vitest";
import { scrubSensitive } from "@/lib/server-logger";

describe("scrubSensitive (Finding #12)", () => {
  it("redacts password= assignments", () => {
    expect(scrubSensitive("login failed with password=hunter2"))
      .toBe("login failed with password=<redacted>");
  });

  it("redacts token= assignments (any key shape)", () => {
    expect(scrubSensitive("Bearer token=abc123xyz"))
      .toBe("Bearer token=<redacted>");
    expect(scrubSensitive("api_key=pf_1234567890abcdef"))
      .toBe("api_key=<redacted>");
    expect(scrubSensitive("mfa_secret=JBSWY3DPEHPK3PXP"))
      .toBe("mfa_secret=<redacted>");
  });

  it("redacts loose pf_ tokens even outside an assignment", () => {
    const input = "got header Authorization: Bearer pf_oauth_" + "a".repeat(64);
    const out = scrubSensitive(input);
    expect(out).not.toContain("pf_oauth_");
    expect(out).toContain("<redacted-pf-token>");
  });

  it("redacts long hex runs (likely secrets)", () => {
    const hex64 = "a".repeat(64);
    const out = scrubSensitive(`stored hash was ${hex64} oops`);
    expect(out).not.toContain(hex64);
    expect(out).toContain("<redacted-hex>");
  });

  it("redacts emails", () => {
    const out = scrubSensitive("user alice@example.com tried to log in");
    expect(out).not.toContain("alice@example.com");
    expect(out).toContain("<redacted-email>");
  });

  it("leaves benign text alone", () => {
    expect(scrubSensitive("Failed to compute budget: invalid category")).toBe(
      "Failed to compute budget: invalid category"
    );
  });

  it("handles multiple patterns in one string", () => {
    const s = 'Auth failure for user@x.com with password=xyz123 token pf_abc' + 'd'.repeat(32);
    const out = scrubSensitive(s);
    expect(out).not.toContain("user@x.com");
    expect(out).not.toContain("xyz123");
    expect(out).toContain("<redacted-email>");
    expect(out).toContain("password=<redacted>");
  });
});
