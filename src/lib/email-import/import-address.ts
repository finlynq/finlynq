/**
 * Per-environment import-address local-part prefix (2026-06-05).
 *
 * DevManager's Mailpit relay is a single catch-all for all import mail on the
 * IMPORT_EMAIL_DOMAIN (mail.finlynq.com as of 2026-06-05 — moved off the root
 * finlynq.com so that domain's MX is free for normal mail) and routes by
 * local-part prefix to the right environment's receiver:
 *
 *   import-<hex>@mail.finlynq.com     → prod  (https://finlynq.com/api/import/email-webhook)
 *   importdev-<hex>@mail.finlynq.com  → dev   (https://dev.finlynq.com/api/import/email-webhook)
 *
 * So each env must GENERATE and MATCH its own prefix. Driven by the env var
 * IMPORT_EMAIL_LOCALPART_PREFIX (default 'import-'; dev sets 'importdev-').
 * The hex token (>=8 hex) and everything else are unchanged, and prod leaves
 * the env unset so existing 'import-<hex>' addresses stay valid.
 */

/** Active local-part prefix for this env. Default 'import-'. */
export function importLocalpartPrefix(): string {
  const p = process.env.IMPORT_EMAIL_LOCALPART_PREFIX;
  return p && p.length > 0 ? p : "import-";
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * `^<prefix><8..64 lowercase hex>$` for the active env prefix. Built per call
 * (cheap) so a runtime env change is honored without a rebuild. The DB lookup
 * on the full address is what actually authorizes — this is just the pre-filter
 * (loose 8..64 to cover legacy 8-hex tokens + current 32-hex tokens).
 */
export function importAddressRegex(): RegExp {
  const p = importLocalpartPrefix().replace(REGEX_SPECIALS, "\\$&");
  return new RegExp(`^${p}[a-f0-9]{8,64}$`);
}
