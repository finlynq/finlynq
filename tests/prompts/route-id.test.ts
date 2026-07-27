/**
 * FINLYNQ-301 phase 2 — dynamic-segment id extraction for the prompt routes.
 * apiHandler doesn't forward Next's `{ params }`, so the routes read `[id]` from
 * the path; this pins that parse.
 */
import { describe, it, expect } from "vitest";
import { promptIdFromRequest } from "@/app/api/prompts/_route-id";

function req(url: string) {
  // Minimal stand-in: promptIdFromRequest falls back to new URL(request.url)
  // when nextUrl throws, so a plain object with a `url` is enough.
  return { url, get nextUrl(): never { throw new Error("no nextUrl"); } } as never;
}

describe("promptIdFromRequest", () => {
  it("pulls the id from an /answer path", () => {
    expect(promptIdFromRequest(req("https://x.test/api/prompts/display_currency/answer"))).toBe(
      "display_currency",
    );
  });
  it("pulls the id from a /defer path", () => {
    expect(promptIdFromRequest(req("https://x.test/api/prompts/some_id/defer"))).toBe("some_id");
  });
  it("url-decodes the segment", () => {
    expect(promptIdFromRequest(req("https://x.test/api/prompts/a%20b/answer"))).toBe("a b");
  });
});
