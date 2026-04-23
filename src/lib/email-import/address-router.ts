/**
 * Email Import — 3-way `to` address router.
 *
 * Classifies an incoming `to` address into one of three categories:
 *
 *   - `import`  — local-part matches /^import-[a-f0-9]{8}$/ AND resolves to a
 *                 user via settings.import_email. Transactions get staged for
 *                 review at /import/pending.
 *   - `mailbox` — reserved prefixes (info/admin/support/hello/contact/sales/
 *                 help) OR matches a user's display_name (case-insensitive,
 *                 ascii-alphanumeric). Admin triages via /admin/inbox.
 *   - `trash`   — everything else. Auto-deleted after 24h.
 *
 * The webhook returns HTTP 200 for all three so no external status-code
 * leak. See Research/email-import-resend-plan.md.
 */

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";

export type AddressCategory = "import" | "mailbox" | "trash";

export interface AddressRoute {
  category: AddressCategory;
  /** Populated only when category === "import" — the user whose import address this matches. */
  userId?: string;
  /** The local-part (before @). Useful for logs + mailbox routing display. */
  localPart: string;
  /** Normalized lowercased full address. */
  address: string;
}

const IMPORT_PREFIX_RE = /^import-[a-f0-9]{8}$/;
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
 * @param rawTo  The address as received in the Resend payload (e.g.
 *               `"import-abc123de@finlynq.com"` or
 *               `"Admin <admin@finlynq.com>"`). Case-insensitive.
 */
export async function routeAddress(rawTo: string): Promise<AddressRoute> {
  // Extract `<addr>` if the header uses display-name form, else use as-is.
  const match = /<([^>]+)>/.exec(rawTo);
  const address = (match ? match[1] : rawTo).trim().toLowerCase();
  const [localPart] = address.split("@");

  // --- 1. Import address? ---
  if (localPart && IMPORT_PREFIX_RE.test(localPart)) {
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
    // Import-shaped but no user match — probably expired/rotated. Trash.
    return { category: "trash", localPart, address };
  }

  // --- 2. Reserved mailbox prefix? ---
  if (localPart && MAILBOX_PREFIXES.has(localPart)) {
    return { category: "mailbox", localPart, address };
  }

  // --- 3. Named-human match against existing users? ---
  if (localPart && NAMED_HUMAN_RE.test(localPart)) {
    // Exact case-insensitive match against display_name. This is cheap (one
    // SQL query) and the false-positive rate is low because display_names
    // are typically "Hussein Halawi" not "admin" — but we still want to hit
    // this path so human-named mailboxes route to admin triage rather than
    // trash.
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
