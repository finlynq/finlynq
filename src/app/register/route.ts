/**
 * POST /register
 *
 * Alias for /api/oauth/register — some OAuth clients (including Claude)
 * attempt registration at the root /register path in addition to the
 * registration_endpoint advertised in the discovery document.
 */

export { POST, OPTIONS } from "@/app/api/oauth/register/route";
