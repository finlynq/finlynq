/**
 * GET /.well-known/oauth-protected-resource/api/mcp — RFC 9728 §3.1 metadata
 * for the resource https://<host>/api/mcp, at the path-inserted location
 * clients derive from the resource URL (GH #424 follow-up, 2026-11-20).
 */
export { GET, OPTIONS } from "@/app/api/mcp/.well-known/oauth-protected-resource/route";
