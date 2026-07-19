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
  dataResponse,
  decryptNameish,
  resolveEntity,
  resolveOrReport,
  supportedCurrencyEnum,
  type Row,
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
  getUserTransactions,
} from "../../src/lib/mcp/user-tx-cache";
import {
  signPreviewToken,
  verifyPreviewToken,
} from "./_confirm";
import {
  ymdDate,
} from "../lib/date-validators";
import { resolveReportingCurrency } from "../reporting-currency";
import { getRate } from "../../src/lib/fx-service";
import { tagAmount } from "../currency-tagging";
import { registerManageTool, registerAlias } from "./_consolidate";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function registerSubscriptionsTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, dek, encNote, decNote } = ctx;


  // FINLYNQ-263 phase 2 — list/add/bulk_add/update/delete_subscription folded
  // into manage_subscriptions (op discriminator; add accepts single or items[];
  // list accepts include_summary, absorbing get_subscription_summary from
  // reads.ts). Bodies lifted VERBATIM; old names stay hidden aliases.
  // detect_subscriptions stays 1:1.

  // ── op: list — lifted VERBATIM from list_subscriptions ─────────────────────
  async function opList(args: { status?: "active" | "paused" | "cancelled" | "all" }): Promise<ToolResult> {
      const { status } = args;
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

  // ── op: add (single) — lifted VERBATIM from add_subscription ───────────────
  async function opAddSingle(args: {
    name: string;
    amount: number;
    cadence: "weekly" | "monthly" | "quarterly" | "annual" | "yearly";
    next_billing_date: string;
    currency?: string;
    category?: string;
    category_id?: number;
    account?: string;
    account_id?: number;
    notes?: string;
  }): Promise<ToolResult> {
      const { name, amount, cadence, next_billing_date, currency, category, category_id, account, account_id, notes } = args;
      // An omitted subscription currency follows the user's display/reporting
      // currency. The resolver falls back to CAD only when no display currency
      // has been configured, so a CHF-configured user never gets an implicit
      // CAD subscription.
      const resolvedCurrency = await resolveReportingCurrency(db, userId, currency);
      // Stream D Phase 4: subscriptions.name plaintext column dropped — uniqueness
      // gate now relies on name_lookup HMAC. No DEK ⇒ no lookup ⇒ refuse cleanly.
      if (!dek) return err("Cannot create subscription without an unlocked DEK (Stream D Phase 4).");
      const lookup = nameLookup(dek, name);
      const existing = await q(db, sql`
        SELECT id FROM subscriptions
        WHERE user_id = ${userId} AND name_lookup = ${lookup}
      `);
      if (existing.length) return err(`Subscription "${name}" already exists (id: ${existing[0].id})`);

      // FINLYNQ-267: resolve category/account via the shared envelope — a
      // mistyped name is REFUSED and a 2+ match returns an ambiguous list;
      // `category_id`/`account_id` are FK fast-paths.
      let categoryId: number | null = null;
      if (category_id != null || category) {
        const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
        const allCats = decryptNameish(rawCats, dek);
        const out = resolveOrReport("category", resolveEntity({ entity: "category", id: category_id, name: category, options: allCats }));
        if ("report" in out) return out.report;
        categoryId = out.id;
      }
      let accountId: number | null = null;
      if (account_id != null || account) {
        const rawAccounts = await q(db, sql`
          SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const out = resolveOrReport("account", resolveEntity({ entity: "account", id: account_id, name: account, options: allAccounts }));
        if ("report" in out) return out.report;
        accountId = out.id;
      }
      const n = dek ? encryptName(dek, name) : { ct: null, lookup: null };
      // Stream D Phase 4 — plaintext name dropped.
      const result = await q(db, sql`
        INSERT INTO subscriptions (user_id, amount, currency, frequency, category_id, account_id, next_date, status, notes, name_ct, name_lookup)
        VALUES (${userId}, ${amount}, ${resolvedCurrency}, ${cadence}, ${categoryId}, ${accountId}, ${next_billing_date}, 'active', ${notes != null ? encNote(notes) : null}, ${n.ct}, ${n.lookup})
        RETURNING id
      `);
      return text({ success: true, data: { id: Number(result[0]?.id), message: `Subscription "${name}" created — ${resolvedCurrency} ${amount} ${cadence}, next ${next_billing_date}` } });
  }

  // ── op: update — lifted VERBATIM from update_subscription ──────────────────
  async function opUpdate(args: {
    id: number;
    name?: string;
    amount?: number;
    cadence?: "weekly" | "monthly" | "quarterly" | "annual" | "yearly";
    next_billing_date?: string;
    currency?: string;
    category?: string;
    category_id?: number;
    account?: string;
    account_id?: number;
    status?: "active" | "paused" | "cancelled";
    cancel_reminder_date?: string;
    notes?: string;
  }): Promise<ToolResult> {
      const { id, name, amount, cadence, next_billing_date, currency, category, category_id, account, account_id, status, cancel_reminder_date, notes } = args;
      const existing = await q(db, sql`SELECT id FROM subscriptions WHERE id = ${id} AND user_id = ${userId}`);
      if (!existing.length) return err(`Subscription #${id} not found`);

      // FINLYNQ-267: `*_id` FK fast-path wins; a name resolves via the shared
      // envelope (mistyped → refuse, 2+ → ambiguous). Empty string on the NAME
      // param still CLEARS the link (unchanged legacy behavior).
      let categoryIdUpdate: number | null | undefined;
      if (category_id != null) {
        const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
        const allCats = decryptNameish(rawCats, dek);
        const out = resolveOrReport("category", resolveEntity({ entity: "category", id: category_id, options: allCats }));
        if ("report" in out) return out.report;
        categoryIdUpdate = out.id;
      } else if (category !== undefined) {
        if (category === "") categoryIdUpdate = null;
        else {
          const rawCats = await q(db, sql`SELECT id, name_ct FROM categories WHERE user_id = ${userId}`);
          const allCats = decryptNameish(rawCats, dek);
          const out = resolveOrReport("category", resolveEntity({ entity: "category", name: category, options: allCats }));
          if ("report" in out) return out.report;
          categoryIdUpdate = out.id;
        }
      }
      let accountIdUpdate: number | null | undefined;
      if (account_id != null) {
        const rawAccounts = await q(db, sql`
          SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
        `);
        const allAccounts = decryptNameish(rawAccounts, dek);
        const out = resolveOrReport("account", resolveEntity({ entity: "account", id: account_id, options: allAccounts }));
        if ("report" in out) return out.report;
        accountIdUpdate = out.id;
      } else if (account !== undefined) {
        if (account === "") accountIdUpdate = null;
        else {
          const rawAccounts = await q(db, sql`
            SELECT id, name_ct, alias_ct FROM accounts WHERE user_id = ${userId}
          `);
          const allAccounts = decryptNameish(rawAccounts, dek);
          const out = resolveOrReport("account", resolveEntity({ entity: "account", name: account, options: allAccounts }));
          if ("report" in out) return out.report;
          accountIdUpdate = out.id;
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

  // ── op: delete — id OR resolver name (FINLYNQ-273) ─────────────────────────
  // Was id-only. Subscription names live in `name_ct` (decryptable), so a name
  // path resolves through the shared envelope (id fast-path wins; mistyped →
  // refuse with a `Did you mean` list; 2+ → ambiguous) — the SAME refusal shape
  // as goals/holdings/categories.
  async function opDelete(args: { id?: number; name?: string }): Promise<ToolResult> {
      const { id, name } = args;
      if (id == null && (name == null || name === "")) {
        return err("Pass `id` (numeric) or `name` (fuzzy) to identify the subscription.");
      }
      let subId = id;
      if (subId == null) {
        if (!dek) return err("Cannot resolve subscription by name without an unlocked DEK (Stream D Phase 4). Pass `id` instead.");
        const rawSubs = await q(db, sql`SELECT id, name_ct FROM subscriptions WHERE user_id = ${userId}`);
        const allSubs = decryptNameish(rawSubs, dek);
        const out = resolveOrReport("subscription", resolveEntity({ entity: "subscription", name, options: allSubs }));
        if ("report" in out) return out.report;
        subId = out.id;
      }
      const existing = await q(db, sql`SELECT id, name_ct FROM subscriptions WHERE id = ${subId} AND user_id = ${userId}`);
      if (!existing.length) return err(`Subscription #${subId} not found`);
      // Stream D Phase 4: name plaintext dropped — decrypt name_ct via DEK.
      const decryptedName = existing[0].name_ct && dek ? decryptField(dek, String(existing[0].name_ct)) : null;
      await db.execute(sql`DELETE FROM subscriptions WHERE id = ${subId} AND user_id = ${userId}`);
      return text({ success: true, data: { id: subId, message: `Subscription "${decryptedName ?? `#${subId}`}" deleted` } });
  }

  // ── opSummary — lifted VERBATIM from get_subscription_summary (was reads.ts) ─
  async function opSummary(args: { reportingCurrency?: string }): Promise<ToolResult> {
      const { reportingCurrency } = args;
      const rawSubs = await q(db, sql`
        SELECT s.id, s.name_ct, s.amount, s.currency, s.frequency, s.next_date, s.status,
               c.name_ct AS category_name_ct
        FROM subscriptions s
        LEFT JOIN categories c ON s.category_id = c.id
        WHERE s.user_id = ${userId}
        ORDER BY s.status
      `);
      // Issue #207 — explicit whitelist so *_ct ciphertexts never escape via
      // the downstream `taggedSubs` spread. Building a clean shape here means
      // `taggedSubs.map(s => ({ ...s, ... }))` below carries no ciphertext.
      const subs: Row[] = rawSubs.map((r) => ({
        id: r.id,
        amount: r.amount,
        currency: r.currency,
        frequency: r.frequency,
        next_date: r.next_date,
        status: r.status,
        category_id: r.category_id,
        name: r.name_ct && dek ? decryptField(dek, r.name_ct) : null,
        category_name: r.category_name_ct && dek ? decryptField(dek, r.category_name_ct) : null,
      }));

      const active = subs.filter(s => s.status === "active");
      const freqMult: Record<string, number> = { weekly: 4.33, monthly: 1, quarterly: 1/3, annual: 1/12, yearly: 1/12 };

      const reporting = await resolveReportingCurrency(db, userId, reportingCurrency);
      const today = new Date().toISOString().split("T")[0];
      const fxByCcy = new Map<string, number>();
      for (const ccy of new Set(active.map(s => String(s.currency ?? reporting)))) {
        fxByCcy.set(ccy, await getRate(ccy, reporting, today, userId));
      }

      let totalMonthlyCostReporting = 0;
      const taggedSubs = subs.map(s => {
        const ccy = String(s.currency ?? reporting);
        const fx = fxByCcy.get(ccy) ?? 1;
        return {
          ...s,
          amountTagged: tagAmount(Number(s.amount), ccy, "account"),
          amountReporting: tagAmount(Number(s.amount) * fx, reporting, "reporting"),
        };
      });
      for (const s of active) {
        const ccy = String(s.currency ?? reporting);
        const fx = fxByCcy.get(ccy) ?? 1;
        totalMonthlyCostReporting += Number(s.amount) * fx * (freqMult[s.frequency] ?? 1);
      }

      const thirtyDays = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
      const upcoming = active
        .filter(s => s.next_date && s.next_date >= today && s.next_date <= thirtyDays)
        .map(s => {
          const ccy = String(s.currency ?? reporting);
          const fx = fxByCcy.get(ccy) ?? 1;
          return {
            name: s.name,
            amount: s.amount,
            date: s.next_date,
            currency: s.currency,
            amountTagged: tagAmount(Number(s.amount), ccy, "account"),
            amountReporting: tagAmount(Number(s.amount) * fx, reporting, "reporting"),
          };
        })
        .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));

      return dataResponse({
        reportingCurrency: reporting,
        totalMonthlyCost: tagAmount(totalMonthlyCostReporting, reporting, "reporting"),
        totalAnnualCost: tagAmount(totalMonthlyCostReporting * 12, reporting, "reporting"),
        activeCount: active.length,
        totalCount: subs.length,
        upcomingRenewals: upcoming,
        subscriptions: taggedSubs,
        // FINLYNQ-268 (phase 4, flow axis): subscription costs are recurring
        // cash-flow figures (monthly/annual spend), not portfolio valuation.
        basis: "cash_flow",
      });
  }

  // ── op: list with optional summary ─────────────────────────────────────────
  // list_subscriptions alias → opList (byte-identical). manage_subscriptions
  // op:list with include_summary:true also runs opSummary and merges it under a
  // `summary` key; without it, returns the plain list unchanged.
  async function opListWithOptionalSummary(args: {
    status?: "active" | "paused" | "cancelled" | "all";
    include_summary?: boolean;
    reportingCurrency?: string;
  }): Promise<ToolResult> {
    const listRes = await opList({ status: args.status });
    if (args.include_summary !== true) return listRes;
    const summaryRes = await opSummary({ reportingCurrency: args.reportingCurrency });
    const listPayload = JSON.parse(listRes.content[0].text);
    const summaryPayload = JSON.parse(summaryRes.content[0].text);
    return text({ ...listPayload, summary: summaryPayload.data });
  }

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
        ? signPreviewToken(userId, "bulk_add_subscriptions", { candidates: approvable })
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


  // ── op: add (bulk) — lifted VERBATIM from bulk_add_subscriptions ───────────
  async function opBulkAdd(args: {
    candidates: Array<{
      payee: string;
      amount: number;
      cadence: "weekly" | "monthly" | "quarterly" | "annual";
      next_billing_date?: string;
      category_id?: number;
    }>;
    confirmation_token: string;
  }): Promise<ToolResult> {
      const { candidates, confirmation_token } = args;
      // The token is signed over {payee, amount, cadence} only — additional
      // fields (next_billing_date, category_id) don't change the approval.
      const approvable = candidates.map((c) => ({
        payee: c.payee,
        amount: c.amount,
        cadence: c.cadence,
      }));
      const check = verifyPreviewToken(confirmation_token, userId, "bulk_add_subscriptions", { candidates: approvable });
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
      const resolvedCurrency = await resolveReportingCurrency(db, userId, undefined);
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
          VALUES (${userId}, ${c.amount}, ${resolvedCurrency}, ${c.cadence}, ${c.category_id ?? null}, NULL, ${next}, 'active', 'Auto-detected by MCP', ${enc.ct}, ${enc.lookup})
        `);
        created++;
      }
      return text({ success: true, data: { created, skipped, message: `Created ${created} subscription(s); skipped ${skipped.length} existing` } });
  }

  // ── consolidated tool: manage_subscriptions + hidden back-compat aliases ────
  registerManageTool(
    server,
    "manage_subscriptions",
    "Manage subscriptions: `op` selects add / update / delete / list. add: one (name/amount/cadence/next_billing_date) or many (pass `items[]` + the `confirmation_token` from detect_subscriptions). update: change any field by id. delete: remove by id. list: raw editable rows (filter by `status`); `include_summary:true` also adds cost/renewal totals under a `summary` key.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("add"),
        // Single-add fields (used when `items` is omitted):
        name: z.string().optional().describe("Subscription name (unique per user). For a single add."),
        amount: z.number().positive().optional().describe("Amount per billing cycle (must be > 0). For a single add."),
        cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).optional().describe("Billing frequency. For a single add."),
        next_billing_date: ymdDate.optional().describe("Next billing date (YYYY-MM-DD). For a single add."),
        currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency code. If omitted, inherits settings.display_currency; fallback is CAD when no display currency is configured."),
        category: z.string().optional().describe("Category name (fuzzy matched — mistyped/unmatched is REFUSED, never silently unlinked). Single add."),
        category_id: z.number().int().positive().optional().describe("Category FK fast-path — wins over the fuzzy `category` name. Single add."),
        account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias — mistyped/unmatched is REFUSED). Single add."),
        account_id: z.number().int().positive().optional().describe("Account FK fast-path — wins over the fuzzy `account` name. Single add."),
        notes: z.string().optional(),
        // Bulk-add fields (used when `items` is present):
        items: z.array(z.object({
          payee: z.string(),
          amount: z.number(),
          cadence: z.enum(["weekly", "monthly", "quarterly", "annual"]),
          next_billing_date: ymdDate.optional().describe("YYYY-MM-DD. Defaults to today + cadence interval"),
          category_id: z.number().optional(),
        })).min(1).optional().describe("Bulk add — the candidates returned by detect_subscriptions. Requires `confirmation_token`."),
        confirmation_token: z.string().optional().describe("Token from detect_subscriptions — required when `items` is passed."),
      }),
      z.object({
        op: z.literal("update"),
        id: z.number().describe("Subscription id"),
        name: z.string().optional(),
        amount: z.number().positive().optional().describe("Amount per billing cycle (must be > 0)"),
        cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).optional(),
        next_billing_date: ymdDate.optional().describe("YYYY-MM-DD"),
        currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency code (issue #206: full SUPPORTED_CURRENCIES list)."),
        category: z.string().optional().describe("Category name (fuzzy — mistyped/unmatched is REFUSED). Empty string clears."),
        category_id: z.number().int().positive().optional().describe("Category FK fast-path — wins over the fuzzy `category` name."),
        account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias — mistyped/unmatched is REFUSED). Empty string clears."),
        account_id: z.number().int().positive().optional().describe("Account FK fast-path — wins over the fuzzy `account` name."),
        status: z.enum(["active", "paused", "cancelled"]).optional(),
        cancel_reminder_date: ymdDate.optional().describe("YYYY-MM-DD"),
        notes: z.string().optional(),
      }),
      z.object({
        op: z.literal("delete"),
        id: z.number().int().positive().optional().describe("Subscription FK fast-path — wins over the fuzzy `name`. Pass this OR `name`."),
        name: z.string().optional().describe("Subscription name (fuzzy matched — mistyped/unmatched is REFUSED with a `Did you mean` list; 2+ → ambiguous). Requires an unlocked DEK. Pass `id` instead when no DEK is available."),
      }),
      z.object({
        op: z.literal("list"),
        status: z.enum(["active", "paused", "cancelled", "all"]).optional().describe("Filter by status (default: all)"),
        include_summary: z.boolean().optional().describe("When true, ALSO return aggregate monthly/annual cost + upcoming renewals under a `summary` key."),
        reportingCurrency: z.string().optional().describe("ISO code for the summary totals; defaults to user's display currency. Only used with include_summary."),
      }),
    ]),
    async (input) => {
      switch (input.op) {
        case "add":
          if (input.items !== undefined) {
            return opBulkAdd({ candidates: input.items, confirmation_token: input.confirmation_token ?? "" });
          }
          return opAddSingle({
            name: input.name ?? "",
            amount: input.amount ?? 0,
            cadence: input.cadence ?? "monthly",
            next_billing_date: input.next_billing_date ?? new Date().toISOString().split("T")[0],
            currency: input.currency,
            category: input.category,
            account: input.account,
            notes: input.notes,
          });
        case "update":
          return opUpdate(input);
        case "delete":
          return opDelete(input);
        case "list":
          return opListWithOptionalSummary(input);
      }
    },
  );

  registerAlias(
    server,
    "list_subscriptions",
    "List all subscriptions with full detail (status, next billing, category, account, notes). Issue #210 — `amount` is always positive (the storage convention); a subscription is by definition an outflow. Intended split: use this for the raw editable row set; use get_subscription_summary for aggregate monthly/annual cost + upcoming renewals, and get_recurring_transactions for engine-DETECTED recurrences that are not tracked subscriptions.",
    { status: z.enum(["active", "paused", "cancelled", "all"]).optional().describe("Filter by status (default: all)") },
    async (args) => opList(args),
  );
  registerAlias(
    server,
    "add_subscription",
    "Create a new subscription. Issue #210 — `amount` MUST be positive (the storage convention). A subscription is by definition an outflow; the sign is implicit, not in the value.",
    {
      name: z.string().describe("Subscription name (unique per user)"),
      amount: z.number().positive().describe("Amount per billing cycle (must be > 0)"),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).describe("Billing frequency"),
      next_billing_date: ymdDate.describe("Next billing date (YYYY-MM-DD)"),
      currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency code. If omitted, inherits settings.display_currency; fallback is CAD when no display currency is configured."),
      category: z.string().optional().describe("Category name (fuzzy matched — mistyped/unmatched is REFUSED)"),
      category_id: z.number().int().positive().optional().describe("Category FK fast-path — wins over the fuzzy `category` name."),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias — mistyped/unmatched is REFUSED)"),
      account_id: z.number().int().positive().optional().describe("Account FK fast-path — wins over the fuzzy `account` name."),
      notes: z.string().optional(),
    },
    async (args) => opAddSingle(args),
  );
  registerAlias(
    server,
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
    async (args) => opBulkAdd(args),
  );
  registerAlias(
    server,
    "update_subscription",
    "Update any field of an existing subscription",
    {
      id: z.number().describe("Subscription id"),
      name: z.string().optional(),
      amount: z.number().positive().optional().describe("Amount per billing cycle (must be > 0)"),
      cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "yearly"]).optional(),
      next_billing_date: ymdDate.optional().describe("YYYY-MM-DD"),
      currency: supportedCurrencyEnum.optional().describe("ISO 4217 currency code (issue #206: full SUPPORTED_CURRENCIES list)."),
      category: z.string().optional().describe("Category name (fuzzy — mistyped/unmatched is REFUSED). Empty string clears."),
      category_id: z.number().int().positive().optional().describe("Category FK fast-path — wins over the fuzzy `category` name."),
      account: z.string().optional().describe("Account name or alias (fuzzy matched against name; exact match on alias — mistyped/unmatched is REFUSED). Empty string clears."),
      account_id: z.number().int().positive().optional().describe("Account FK fast-path — wins over the fuzzy `account` name."),
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      cancel_reminder_date: ymdDate.optional().describe("YYYY-MM-DD"),
      notes: z.string().optional(),
    },
    async (args) => opUpdate(args),
  );
  registerAlias(
    server,
    "delete_subscription",
    "Permanently delete a subscription by id or name (`name` resolves via the shared envelope; `id` fast-path wins).",
    {
      id: z.number().int().positive().optional().describe("Subscription FK fast-path — wins over `name`. Pass this OR `name`."),
      name: z.string().optional().describe("Subscription name (fuzzy matched — mistyped/unmatched is REFUSED; 2+ → ambiguous). Requires an unlocked DEK."),
    },
    async (args) => opDelete(args),
  );
  registerAlias(
    server,
    "get_subscription_summary",
    "Get all tracked subscriptions with total monthly cost and upcoming renewals. Each subscription's amount is in its own currency; totals are converted to reportingCurrency (defaults to user's display currency). Intended split: use this for AGGREGATE cost + upcoming-renewal roll-ups; use list_subscriptions for the raw editable row set, and get_recurring_transactions for transactions the engine DETECTED as recurring (not user-tracked subscriptions).",
    {
      reportingCurrency: z.string().optional().describe("ISO code; defaults to user's display currency. Used for the unified total monthly/annual cost."),
    },
    async (args) => opSummary(args),
  );
}
