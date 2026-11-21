/**
 * GET /.well-known/oauth-protected-resource — RFC 9728 metadata at its
 * standard root location (GH #424 follow-up, 2026-11-20).
 *
 * Same document as /api/mcp/.well-known/oauth-protected-resource (which our
 * 401 challenge points at). Clients that don't follow the challenge header and
 * look in the standard places (Gemini's connector among them) found 404 here.
 */
export { GET, OPTIONS } from "@/app/api/mcp/.well-known/oauth-protected-resource/route";
