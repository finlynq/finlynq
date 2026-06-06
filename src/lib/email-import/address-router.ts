/**
 * Email Import — 3-way `to` address router.
 *
 * Classifies an incoming `to` address into one of four categories:
 *
 *   - `import`  — local-part matches the env import-prefix regex (see
 *                 import-address.ts; 'import-' prod / 'importdev-' dev) AND
 *                 resolves to a user via settings.import_email. Transactions get
 *                 staged for review at /import. (The regex is loose, 8..64 hex,
 *                 to cover legacy 8-hex tokens + current 32-hex tokens; the DB
 *                 lookup on the full address is what actually authorizes.)
 *   - `discard` — import-shaped (matches the prefix regex) but NO user matches
 *                 in this env (expired/rotated token, or spam to a guessed
 *                 import address forwarded by the relay). The webhook 2xx's and
 *                 writes NOTHING (no row, no bounce, no admin notify) so the
 *                 DevManager relay deletes the Mailpit copy instead of looping.
 *   - `mailbox` — reserved prefixes (info/admin/support/hello/contact/sales/
 *                 help) OR matches a user's display_name (case-insensitive,
 *                 ascii-alphanumeric). Admin triages via /admin/inbox.
 *   - `trash`   — everything else (non-import junk). Auto-deleted after 24h.
 *
 * The webhook returns HTTP 200 for all categories so no external status-code
 * leak. See Research/email-import-resend-plan.md.
 */

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { importAddressRegex } from "./import-address";

export type AddressCategory = "import" | "discard" | "mailbox" | "trash";

export interface AddressRoute {
  category: AddressCategory;
  /** Populated only when category === "import" — the user whose import address this matches. */
  userId?: string;
  /** The local-part (before @). Useful for logs + mailbox routing display. */
  localPart: string;
  /** Normalized lowercased full address. */
  address: string;
}

const MAILBOX_PREFIXES = new Set([
  "info",
  "admin",
  "support",
  "hello",
  "contact",
  "sales",
  "help",
]);
/** A "named human" local-part: ASCII letters, digits, dot, hyphen, underscore, 2–30 chars. */
const NAMED_HUMAN_RE = /^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$/;

/**
 * Parse and classify a single `to` address.
 *
 * @param rawTo  The address as received in the inbound payload (e.g.
 *               `"import-abc123de@mail.finlynq.com"` or
 *               `"Admin <admin@finlynq.com>"`). Case-insensitive.
 */
export async function routeAddress(rawTo: string): Promise<AddressRoute> {
  // Extract `<addr>` if the header uses display-name form, else use as-is.
  const match = /<([^>]+)>/.exec(rawTo);
  const address = (match ? match[1] : rawTo).trim().toLowerCase();
  const [localPart] = address.split("@");

  // --- 1. Import address? ---
  if (localPart && importAddressRegex().test(localPart)) {
    const row = await db
      .select({ userId: schema.settings.userId })
      .from(schema.settings)
      .where(and(
        eq(schema.settings.key, "import_email"),
        eq(schema.settings.value, address),
      ))
      .get();
    if (row?.userId) {
      return { category: "import", userId: row.userId, localPart, address };
    }
    // Import-shaped but no user match — probably expired/rotated, or spam to a
    // guessed import address the relay forwarded. Discard: 2xx + no row, so the
    // DevManager relay deletes the Mailpit copy rather than looping (no bounce/
    // admin-notify either — a rotated token shouldn't spam our admins).
    return { category: "discard", localPart, address };
  }

  // --- 2. Reserved mailbox prefix? ---
  if (localPart && MAILBOX_PREFIXES.has(localPart)) {
    return { category: "mailbox", localPart, address };
  }

  // --- 3. Named-human match against existing users? ---
  if (localPart && NAMED_HUMAN_RE.test(localPart)) {
    // Exact case-insensitive match against display_name. This is cheap (one
    // SQL query) and the false-positive rate is low because display_names
    // are typically a real human name like "Jane Doe" not "admin" — but we
    // still want to hit this path so human-named mailboxes route to admin
    // triage rather than trash.
    const nameMatch = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.displayName}) = ${localPart}`)
      .get();
    if (nameMatch?.id) {
      return { category: "mailbox", localPart, address };
    }
  }

  // --- 4. Everything else → trash. ---
  return { category: "trash", localPart, address };
}
