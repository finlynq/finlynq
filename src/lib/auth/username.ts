/**
 * Username validation + normalization.
 *
 * Format: 3–254 chars, [a-z0-9._@+_-]. Lowercased on store; uniqueness
 * enforced case-insensitively at the DB level via a partial unique index on
 * lower(username) — see scripts/migrate-username.sql.
 *
 * The character class is intentionally broad enough that an email-shaped
 * string is a valid username (e.g., 'cool.dragon@madeup.fake'). This lets
 * privacy-conscious users pick a pseudo-email handle rather than expose a
 * real one. The 254-char ceiling matches RFC 5321's max email length.
 *
 * Reserved names mirror the email-import router's mailbox prefixes
 * (src/lib/email-import/address-router.ts) plus a defensive block on the
 * 'import-' prefix used by per-user import addresses. The reserved check
 * only applies to *bare* handles (no '@') — once a username contains '@',
 * it's an email-shaped string and 'admin@x.com' is fine because admin role
 * is decided by users.role, not by name.
 *
 * Cross-column collision (username matching another user's email, and vice
 * versa) is the register route's responsibility — see isIdentifierClaimed
 * in src/lib/auth/queries.ts.
 */

const USERNAME_RE = /^[a-z0-9._@+_-]{3,254}$/;

const RESERVED_USERNAMES = new Set<string>([
  "info",
  "admin",
  "administrator",
  "support",
  "help",
  "hello",
  "contact",
  "sales",
  "root",
  "system",
  "api",
  "noreply",
  "no-reply",
  "postmaster",
  "abuse",
  "security",
  "billing",
]);

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export type UsernameValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function validateUsername(input: string): UsernameValidation {
  const value = normalizeUsername(input);
  if (!USERNAME_RE.test(value)) {
    return {
      ok: false,
      error:
        "Username must be 3–254 characters and contain only lowercase letters, digits, '.', '@', '+', '_', or '-'.",
    };
  }
  // Reserved names only apply to bare handles. Email-shaped usernames
  // (containing '@') bypass this check on purpose.
  if (!value.includes("@")) {
    if (RESERVED_USERNAMES.has(value) || value.startsWith("import-")) {
      return { ok: false, error: "This username is reserved." };
    }
  }
  return { ok: true, value };
}
