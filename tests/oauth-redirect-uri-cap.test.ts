/**
 * GH #424 follow-up (2026-11-21) — the Gemini web app registers SIX redirect
 * URIs in one dynamic client registration (3 Google hosts x /r/ and /a/). The
 * old cap of 5 refused the whole request, which Gemini reports only as "This
 * URL does not appear to be a valid MCP server".
 */
import { describe, it, expect } from "vitest";
import { validateRedirectUris, MAX_REDIRECT_URIS_PER_CLIENT } from "@/lib/oauth";

const ID = "user_bound_custom-mcp-52daa21ec0e98956d5f21956";
const GEMINI_REDIRECTS = [
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
].flatMap((host) => ["r", "a"].map((p) => `https://${host}/${p}/${ID}`));

describe("dynamic client registration redirect_uris", () => {
  it("accepts the six redirect URIs the Gemini web app registers", () => {
    expect(GEMINI_REDIRECTS).toHaveLength(6);
    expect(validateRedirectUris(GEMINI_REDIRECTS)).toEqual(GEMINI_REDIRECTS);
  });

  it("still caps the list", () => {
    const tooMany = Array.from({ length: MAX_REDIRECT_URIS_PER_CLIENT + 1 }, (_, i) => `https://example.com/cb/${i}`);
    expect(() => validateRedirectUris(tooMany)).toThrow(/at most/);
  });

  it("still refuses a non-HTTPS, non-localhost redirect", () => {
    expect(() => validateRedirectUris(["http://example.com/cb"])).toThrow(/HTTPS/);
  });
});
