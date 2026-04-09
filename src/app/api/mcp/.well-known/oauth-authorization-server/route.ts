/**
 * GET /api/mcp/.well-known/oauth-authorization-server
 *
 * MCP path-scoped OAuth metadata — mirrors the root /.well-known endpoint.
 * MCP clients that follow RFC 9728 path-prefixed discovery will hit this.
 */

export { GET, OPTIONS } from "@/app/.well-known/oauth-authorization-server/route";
