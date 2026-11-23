/**
 * Whether this server lets new people create accounts (GH #435).
 *
 * Self-hosters who expose Finlynq to the internet (so phones and AI clients can
 * reach it) set `ALLOW_REGISTRATION=false` to stop strangers signing up.
 * Unset, or any other value, keeps sign-up open, so the hosted service and
 * every existing install behave exactly as before.
 *
 * When closed: `POST /api/auth/register` and the username check answer 403,
 * the zero-click demo logins (`/try-demo`, `/try-demo2`) send the visitor to
 * the sign-in page, and the sign-in page hides Create Account and the demo
 * link. Signing in, OAuth and MCP client registration (which registers AI
 * clients, not people) are untouched.
 *
 * Read at request time, never at build time: the published Docker image is
 * built once and configured by each install's environment.
 */
const CLOSED_VALUES = new Set(["false", "0", "no", "off"]);

export function isRegistrationOpen(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.ALLOW_REGISTRATION;
  if (raw == null) return true;
  return !CLOSED_VALUES.has(raw.trim().toLowerCase());
}

export const REGISTRATION_CLOSED_MESSAGE =
  "Sign-up is turned off on this server. Ask its administrator for an account.";
