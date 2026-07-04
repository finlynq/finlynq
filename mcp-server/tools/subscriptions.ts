/**
 * MCP HTTP tool group: subscriptions (FINLYNQ-109 extraction).
 *
 * Handler bodies moved VERBATIM out of register-tools-pg.ts. The only edits
 * are the enclosing function wrapper + the shared-state destructure from ctx.
 * Do not reformat or re-logic the handlers.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  q,
  text,
  err,
  fuzzyFind,
  decryptNameish,
  supportedCurrencyEnum,
  type PgToolContext,
} from "./_shared";
import {
  sql,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  decryptField,
} from "../../src/lib/crypto/envelope";
import {
  encryptName,
  nameLookup,
} from "../../src/lib/crypto/encrypted-columns";
import {
} from "../../src/lib/fx/supported-currencies";
import {
  getUserTransactions,
} from "../../src/lib/mcp/user-tx-cache";
import {
  signConfirmationToken,
  verifyConfirmationToken,
} from "../../src/lib/mcp/confirmation-token";
import {
  ymdDate,
} from "../lib/date-validators";

export function registerSubscriptionsTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek, encNote, decNote } = ctx;


  // ── list_subscriptions ────────────────────────────────────────────────────
  // Distinct from get_subscription_summary (which aggregates monthly cost +
  // upcoming renewals). This returns the raw row set with status + category +
  // account, for editing flows.
  server.tool(
    "list_subscriptions",
    "List all subscriptions with full detail (status, next billing, category, account, notes). Issue #210 — `amount` is always positive (the storage convention); a subscription is by definition an outflow. Intended split: use this for the raw editable row set; use get_subscription_summary for aggregate monthly/annual cost + upcoming renewals, and get_recurring_transactions for engine-DETECTED recurrences that are not tracked subscriptions.",
    { status: z.enum(["active", "paused", "cancelled", "all"]).optional().describe("Filter by status (default: all)") },
    async ({ status }) => {
      // Stream D Phase 4: s.name + c.name + a.name dropped — read *_ct only.
      const raw = await q(db, sql`
        SELECT s.id, s.name_ct, s.amount, s.currency, s.frequency, s.next_date, s.status,
               s.cancel_reminder_date, s.notes,
               s.category_id, c.name_ct AS category_name_ct,
               s.account_id, a.name_ct AS account_name_ct
        FROM subscriptions s
        LEFT JOIN categories c ON c.id = s.category_id
        LEFT JOIN accounts a ON a.id = s.account_id
        WHERE s.user_id = ${userId}
          ${status && status !== "all" ? sql`AND s.status = ${status}` : sql``}
        ORDER BY s.status
      `);
      // Issue #207 — explicit field whitelist so *_ct ciphertexts never escape
      // the encryption boundary. Spreading `r` (`...r`) would carry name_ct,
      // category_name_ct, and account_name_ct through to the client.
      const rows = raw.map((r) => ({
        id: r.id,
        amount: r.amount,
        currency: r.currency,
        frequency: r.frequency,
        next_date: r.next_date,
        status: r.status,
        cancel_reminder_date: r.cancel_reminder_date,
        // Free-text notes is user-DEK encrypted at rest (2026-06-01).
        notes: decNote(r.notes as string | null),
        category_id: r.category_id,
        account_id: r.account_id,
        name: r.name_ct && dek ? decryptField(dek, r.name_ct) : null,
        category_name: r.category_name_ct && dek ? decryptField(dek, r.category_name_ct) : null,
        account_name: r.account_name_ct && dek ? decryptField(dek, r.account_name_ct) : null,
      }));
      return text({ success: true, data: rows });
    }
  );


  // ── add_subscription ──────────────────────────────────────────────────────
  server.tool(
    "add_subscription",
    "Create a new subscription. Issue #210 — `amount` MUST be positive (the storage convention). A subscription is by definition an outflow; the sign is implicit, not in the value.",
    {
      name: z.string().describe("Subscription name (unique per user)"),
      amount: z.number().positive().describe("Amount per billing cycle (must be > 0)"),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).describe("Billing frequency"),
      next_billing_date: ymdDate.describe("Next billing date (YYYY-MM-DD)"),
      currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency code (default CAD). Issue #206: full SUPPORTED_CURRENCIES list."),
      category: z.string().optional().describe("Category name (fuzzy matched)"),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias)"),
      notes: z.string().optional(),
    },
    async ({ name, amount, cadence, next_billing_date, currency, category, account, notes }) => {
      // Stream D Phase 4: subscriptions.name plaintext column dropped — uniqueness
      // gate now relies on name_lookup HMAC. No DEK ⇒ no lookup ⇒ refuse cleanly.
      if (!dek) return err("Cannot create subscription without an unlocked DEK (Stream D Phase 4).");
      const lookup = nameLookup(dek, name);
      const existing = await q(db, sql`
        SELECT id FROM subscriptions
        WHERE user_id = ${userId} AND name_lookup = ${lookup}
      `);
      if (existing.length) return err(`Subscription "${name}" already exists (id: ${existing[0].id})`);

      let categoryId: number | null = null;
      if (category) {
        const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
        const allCats = decryptNameish(rawCats, dek);
        const cat = fuzzyFind(category, allCats);
        if (!cat) return err(`Category "${category}" not found`);
        categoryId = Number(cat.id);
      }
      let accountId: number | null = null;
      if (account) {
        const rawAccounts = await q(db, sql`
          SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const acct = fuzzyFind(account, allAccounts);
        if (!acct) return err(`Account "${account}" not found`);
        accountId = Number(acct.id);
      }
      const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      // Stream D Phase 4 — plaintext name dropped.
      const result = await q(db, sql`
        INSERT INTO subscriptions (user_id, amount, currency, frequency, category_id, account_id, next_date, status, notes, name_ct, name_lookup)
        VALUES (${userId}, ${amount}, ${currency ?? "CAD"}, ${cadence}, ${categoryId}, ${accountId}, ${next_billing_date}, 'active', ${notes != null ? encNote(notes) : null}, ${n.ct}, ${n.lookup})
        RETURNING id
      `);
      return text({ success: true, data: { id: Number(result[0]?.id), message: `Subscription "${name}" created — ${currency ?? "CAD"} ${amount} ${cadence}, next ${next_billing_date}` } });
    }
  );


  // ── update_subscription ───────────────────────────────────────────────────
  server.tool(
    "update_subscription",
    "Update any field of an existing subscription",
    {
      id: z.number().describe("Subscription id"),
      name: z.string().optional(),
      amount: z.number().positive().optional().describe("Amount per billing cycle (must be > 0)"),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).optional(),
      next_billing_date: ymdDate.optional().describe("YYYY-MM-DD"),
      currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency code (issue #206: full SUPPORTED_CURRENCIES list)."),
      category: z.string().optional().describe("Category name (fuzzy). Empty string clears."),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias). Empty string clears."),
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      cancel_reminder_date: ymdDate.optional().describe("YYYY-MM-DD"),
      notes: z.string().optional(),
    },
    async ({ id, name, amount, cadence, next_billing_date, currency, category, account, status, cancel_reminder_date, notes }) => {
      const existing = await q(db, sql`SELECT id FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Subscription #${id} not found`);

      let categoryIdUpdate: number | null | undefined;
      if (category !== undefined) {
        if (category === "") categoryIdUpdate = null;
        else {
          const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
          const allCats = decryptNameish(rawCats, dek);
          const cat = fuzzyFind(category, allCats);
          if (!cat) return err(`Category "${category}" not found`);
          categoryIdUpdate = Number(cat.id);
        }
      }
      let accountIdUpdate: number | null | undefined;
      if (account !== undefined) {
        if (account === "") accountIdUpdate = null;
        else {
          const rawAccounts = await q(db, sql`
            SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
          `);
          const allAccounts = decryptNameish(rawAccounts, dek);
          const acct = fuzzyFind(account, allAccounts);
          if (!acct) return err(`Account "${account}" not found`);
          accountIdUpdate = Number(acct.id);
        }
      }

      // Stream D Phase 4 — plaintext name dropped.
      const updates: ReturnType<typeof sql>[] = [];
      if (name !== undefined) {
        if (!dek) return err("Cannot rename subscription without an unlocked DEK (Stream D Phase 4).");
        const n = encryptName(dek, name);
        updates.push(sql`name_ct = ${n.ct}`, sql`name_lookup = ${n.lookup}`);
      }
      if (amount !== undefined) updates.push(sql`amount = ${amount}`);
      if (cadence !== undefined) updates.push(sql`frequency = ${cadence}`);
      if (next_billing_date !== undefined) updates.push(sql`next_date = ${next_billing_date}`);
      if (currency !== undefined) updates.push(sql`currency = ${currency}`);
      if (categoryIdUpdate !== undefined) updates.push(sql`category_id = ${categoryIdUpdate}`);
      if (accountIdUpdate !== undefined) updates.push(sql`account_id = ${accountIdUpdate}`);
      if (status !== undefined) updates.push(sql`status = ${status}`);
      if (cancel_reminder_date !== undefined) updates.push(sql`cancel_reminder_date = ${cancel_reminder_date}`);
      if (notes !== undefined) updates.push(sql`notes = ${notes != null ? encNote(notes) : null}`);
      if (!updates.length) return err("No fields to update");

      await db.execute(sql`UPDATE subscriptions SET ${sql.join(updates, sql`, `)} WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Subscription #${id} updated (${updates.length} field(s))` } });
    }
  );


  // ── delete_subscription ───────────────────────────────────────────────────
  server.tool(
    "delete_subscription",
    "Permanently delete a subscription by id",
    { id: z.number().describe("Subscription id") },
    async ({ id }) => {
      const existing = await q(db, sql`SELECT id, name_ct FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Subscription #${id} not found`);
      // Stream D Phase 4: name plaintext dropped — decrypt name_ct via DEK.
      const decryptedName = existing[0].name_ct && dek ? decryptField(dek, String(existing[0].name_ct)) : null;
      await db.execute(sql`DELETE FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      return text({ success: true, data: { id, message: `Subscription "${decryptedName ?? `#${id}`}" deleted` } });
    }
  );


  // ─── Part 2 tail — detect_subscriptions + bulk_add_subscriptions ───────────

  // ── detect_subscriptions ───────────────────────────────────────────────────
  server.tool(
    "detect_subscriptions",
    "Scan recent transactions and return candidate subscriptions. Candidates are payees with 3+ regular-cadence occurrences and stable amounts (read from the decrypted tx cache). Returns a confirmationToken for bulk_add_subscriptions. `avgAmount` on each candidate is always positive (matches the `subscriptions.amount` storage convention).",
    {
      lookback_months: z.number().optional().describe("Months of history to scan (default 6)"),
    },
    async ({ lookback_months }) => {
      const months = lookback_months ?? 6;
      const since = new Date();
      since.setMonth(since.getMonth() - months);
      const sinceStr = since.toISOString().split("T")[0];

      const all = await getUserTransactions(userId, dek);
      // Skip rows where payee looks like ciphertext (missing DEK) — we can't
      // meaningfully group on those.
      const recent = all.filter(
        (t) => t.date >= sinceStr && t.payee && !t.payee.startsWith("v1:")
      );

      // Group by normalized payee. Normalization: lowercase + collapse runs
      // of whitespace. Fancy merchant-name cleanup is out of scope here.
      const groups = new Map<string, typeof recent>();
      for (const t of recent) {
        const key = t.payee.toLowerCase().replace(/\s+/g, " ").trim();
        if (!key) continue;
        const list = groups.get(key) ?? [];
        list.push(t);
        groups.set(key, list);
      }

      type Candidate = {
        payee: string;
        avgAmount: number;
        cadence: "weekly" | "monthly" | "quarterly" | "annual";
        confidence: number;
        sampleTransactionIds: number[];
        occurrences: number;
      };
      const candidates: Candidate[] = [];

      for (const [, txs] of groups) {
        if (txs.length < 3) continue;
        // Order ascending by date for interval math.
        txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

        const amounts = txs.map((t) => t.amount);
        const avg = amounts.reduce((s, n) => s + n, 0) / amounts.length;
        if (Math.abs(avg) < 0.01) continue; // zero-amount noise

        // Amount stability: stddev within 5% of |avg|.
        const stddev = Math.sqrt(
          amounts.reduce((s, n) => s + (n - avg) ** 2, 0) / amounts.length
        );
        const stableAmount = stddev <= Math.abs(avg) * 0.05;
        if (!stableAmount) continue;

        // Interval in days between consecutive txs.
        const intervals: number[] = [];
        for (let i = 1; i < txs.length; i++) {
          const d1 = new Date(txs[i - 1].date + "T00:00:00Z").getTime();
          const d2 = new Date(txs[i].date + "T00:00:00Z").getTime();
          intervals.push(Math.round((d2 - d1) / 86400000));
        }
        const avgInt = intervals.reduce((s, n) => s + n, 0) / intervals.length;

        let cadence: Candidate["cadence"] | null = null;
        let tol = 0;
        if (Math.abs(avgInt - 7) <= 1) { cadence = "weekly"; tol = 1; }
        else if (Math.abs(avgInt - 30) <= 3) { cadence = "monthly"; tol = 3; }
        else if (Math.abs(avgInt - 91) <= 7) { cadence = "quarterly"; tol = 7; }
        else if (Math.abs(avgInt - 365) <= 15) { cadence = "annual"; tol = 15; }
        if (!cadence) continue;

        const regular = intervals.every((n) => Math.abs(n - avgInt) <= tol);
        if (!regular) continue;

        // Confidence: count + regularity + amount tightness.
        const countScore = Math.min(1, txs.length / 6); // 6+ = 1.0
        const amtTightness = Math.abs(avg) > 0 ? 1 - Math.min(1, stddev / Math.abs(avg)) : 1;
        const intTightness = 1 - Math.min(1, (stddev === 0 ? 0 : 0) + 0);
        const _ = intTightness;
        const confidence = Math.round(((countScore * 0.4) + (amtTightness * 0.6)) * 100) / 100;

        candidates.push({
          payee: txs[0].payee, // keep the casing from the first row
          avgAmount: Math.round(Math.abs(avg) * 100) / 100,
          cadence,
          confidence,
          occurrences: txs.length,
          sampleTransactionIds: txs.slice(-5).map((t) => t.id),
        });
      }

      candidates.sort((a, b) => b.confidence - a.confidence || b.occurrences - a.occurrences);

      // Payload for the token: just the list Claude is authorised to commit.
      // We don't encode the lookback window — Claude could re-run detect with
      // a different window and the candidates would differ, so we sign the
      // actual shortlist shape it saw.
      const approvable = candidates.map((c) => ({
        payee: c.payee,
        amount: c.avgAmount,
        cadence: c.cadence,
      }));
      const token = candidates.length
        ? signConfirmationToken(userId, "bulk_add_subscriptions", { candidates: approvable })
        : "";

      return text({
        success: true,
        data: {
          scanned: recent.length,
          cacheDegraded: all.length > 0 && all.every((t) => t.payee.startsWith("v1:")),
          candidates,
          confirmationToken: token,
        },
      });
    }
  );


  // ── bulk_add_subscriptions ─────────────────────────────────────────────────
  server.tool(
    "bulk_add_subscriptions",
    "Commit a set of detected subscriptions. Pass the candidates returned by detect_subscriptions (payee + amount + cadence), plus the confirmationToken.",
    {
      candidates: z.array(z.object({
        payee: z.string(),
        amount: z.number(),
        cadence: z.enum(["weekly", "monthly", "quarterly", "annual"]),
        next_billing_date: ymdDate.optional().describe("YYYY-MM-DD. Defaults to today + cadence interval"),
        category_id: z.number().optional(),
      })).min(1),
      confirmation_token: z.string(),
    },
    async ({ candidates, confirmation_token }) => {
      // The token is signed over {payee, amount, cadence} only — additional
      // fields (next_billing_date, category_id) don't change the approval.
      const approvable = candidates.map((c) => ({
        payee: c.payee,
        amount: c.amount,
        cadence: c.cadence,
      }));
      const check = verifyConfirmationToken(confirmation_token, userId, "bulk_add_subscriptions", { candidates: approvable });
      if (!check.valid) return err(`Confirmation token invalid: ${check.reason}. Re-run detect_subscriptions.`);

      const today = new Date();
      const addInterval = (base: Date, cadence: string): string => {
        const d = new Date(base);
        if (cadence === "weekly") d.setDate(d.getDate() + 7);
        else if (cadence === "monthly") d.setMonth(d.getMonth() + 1);
        else if (cadence === "quarterly") d.setMonth(d.getMonth() + 3);
        else d.setFullYear(d.getFullYear() + 1);
        return d.toISOString().split("T")[0];
      };

      let created = 0;
      const skipped: string[] = [];
      for (const c of candidates) {
        // Stream D Phase 4 — plaintext name dropped; lookup-only dedup +
        // encrypted insert. DEK is required.
        if (!dek) return err("Cannot create subscriptions without an unlocked DEK (Stream D Phase 4).");
        const lookupHash = nameLookup(dek, c.payee);
        const existing = await q(db, sql`
          SELECT id FROM subscriptions WHERE user_id = ${userId} AND name_lookup = ${lookupHash}
        `);
        if (existing.length) { skipped.push(c.payee); continue; }
        const next = c.next_billing_date ?? addInterval(today, c.cadence);
        const enc = encryptName(dek, c.payee);
        await db.execute(sql`
          INSERT INTO subscriptions (user_id, amount, currency, frequency, category_id, account_id, next_date, status, notes, name_ct, name_lookup)
          VALUES (${userId}, ${c.amount}, 'CAD', ${c.cadence}, ${c.category_id ?? null}, NULL, ${next}, 'active', 'Auto-detected by MCP', ${enc.ct}, ${enc.lookup})
        `);
        created++;
      }
      return text({ success: true, data: { created, skipped, message: `Created ${created} subscription(s); skipped ${skipped.length} existing` } });
    }
  );
}
