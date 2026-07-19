/**
 * MCP HTTP tool group: fx (FINLYNQ-109 extraction).
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
  type PgToolContext,
} from "./_shared";
import {
  sql,
} from "drizzle-orm";
import {
  z,
} from "zod";
import {
  getRateToUsdDetailed,
  validateCurrencyCode,
  validateFxDate,
  collapseLegSources,
} from "../../src/lib/fx-service";
import {
  roundMoney,
  roundFxRate,
} from "../../src/lib/money";
import {
  ymdDate,
} from "../lib/date-validators";
import { registerManageTool, registerAlias } from "./_consolidate";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function registerFxTools(server: McpServer, ctx: PgToolContext) {
  const { db, userId, encNote, decNote } = ctx;


  // ── get_fx_rate ───────────────────────────────────────────────────────────
  server.tool(
    "get_fx_rate",
    "Get the FX rate to convert 1 unit of `from` into `to` on `date`. Cross-rates are computed by triangulation through USD: rate(from,to) = rate_to_usd[from] / rate_to_usd[to]. The lookup checks user overrides first, then the global cache, then Yahoo/CoinGecko, then the most recent cached rate for each currency.",
    {
      from: z.string().describe("Source currency (ISO 4217 code, e.g. USD)"),
      to: z.string().describe("Target currency (ISO 4217 code, e.g. CAD)"),
      date: ymdDate.optional().describe("YYYY-MM-DD — defaults to today"),
    },
    async ({ from, to, date }) => {
      // Issue #206 — validate currencies + date at the MCP boundary.
      let fromCode: string;
      let toCode: string;
      let d: string;
      try {
        fromCode = validateCurrencyCode(from);
        toCode = validateCurrencyCode(to);
        d = validateFxDate(date ?? new Date().toISOString().split("T")[0]);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      if (fromCode === toCode) {
        return text({ success: true, data: { from: fromCode, to: toCode, date: d, rate: 1, source: "identity" } });
      }
      const fromLookup = await getRateToUsdDetailed(fromCode, d, userId);
      const toLookup = await getRateToUsdDetailed(toCode, d, userId);
      if (toLookup.rate === 0) return err(`Cannot convert into ${toCode} (rate is zero)`);
      const rate = fromLookup.rate / toLookup.rate;
      const warnings: string[] = [];
      for (const lookup of [fromLookup, toLookup]) {
        if (lookup.warning && !warnings.includes(lookup.warning)) warnings.push(lookup.warning);
      }
      if (fromLookup.source === "fallback") warnings.push(`No historical rate available for ${fromCode}; using hardcoded fallback.`);
      if (toLookup.source === "fallback") warnings.push(`No historical rate available for ${toCode}; using hardcoded fallback.`);
      // Issue #231 — top-level `source` is the worst-case across legs so a
      // "yahoo" response can't silently hide a "stale" leg. The earliest
      // (most-stale) effectiveDate is also surfaced.
      const collapsedSource = collapseLegSources([fromLookup, toLookup]);
      const effectiveDate =
        fromLookup.effectiveDate < toLookup.effectiveDate
          ? fromLookup.effectiveDate
          : toLookup.effectiveDate;
      // Issue #208 — `roundFxRate` (8dp) is the bank-standard rate precision.
      return text({ success: true, data: {
        from: fromCode, to: toCode, date: d,
        rate: roundFxRate(rate),
        source: collapsedSource,
        effectiveDate,
        legs: {
          from: { ...fromLookup, currency: fromCode },
          to: { ...toLookup, currency: toCode },
        },
        ...(warnings.length ? { warnings } : {}),
      } });
    }
  );


  // ── manage_fx_overrides op handlers (lifted VERBATIM) ──────────────────────
  async function opList(): Promise<ToolResult> {
    const rows = await q(db, sql`
      SELECT id, currency, date_from, date_to, rate_to_usd, note, created_at
      FROM fx_overrides WHERE user_id = ${userId}
      ORDER BY currency, date_from DESC
    `);
    // Free-text note is user-DEK encrypted at rest (2026-06-01).
    const decrypted = rows.map((r) => ({ ...r, note: decNote(r.note as string | null) }));
    return text({ success: true, data: decrypted });
  }

  async function opSet(args: {
    from: string;
    to: string;
    date: string;
    rate: number;
    dateTo?: string;
    note?: string;
  }): Promise<ToolResult> {
    const { from, to, date, rate, dateTo, note } = args;
    // Issue #206 — validate currencies + dates at the MCP boundary so a
    // future-dated or unknown-currency override can't poison the cache
    // via findNearestCached's nearest-row lookup.
    let fromU: string;
    let toU: string;
    let dateFrom: string;
    let dateToFinal: string;
    try {
      fromU = validateCurrencyCode(from);
      toU = validateCurrencyCode(to);
      dateFrom = validateFxDate(date);
      dateToFinal = validateFxDate(dateTo ?? date);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    if (dateToFinal < dateFrom) {
      return err(`dateTo (${dateToFinal}) must be on or after date (${dateFrom}).`);
    }
    let currency: string;
    let rateToUsd: number;
    if (fromU === "USD") {
      currency = toU;
      rateToUsd = 1 / rate;
    } else if (toU === "USD") {
      currency = fromU;
      rateToUsd = rate;
    } else {
      return err(
        `Cross-pair overrides aren't supported directly. Anchor against USD: pin ${fromU}→USD and ${toU}→USD separately. Triangulation will compute ${fromU}→${toU} from those.`
      );
    }
    const result = await q(db, sql`
      INSERT INTO fx_overrides (user_id, currency, date_from, date_to, rate_to_usd, note)
      VALUES (${userId}, ${currency}, ${dateFrom}, ${dateToFinal}, ${rateToUsd}, ${encNote(note)})
      RETURNING id
    `);
    return text({ success: true, data: { id: Number(result[0]?.id), currency, dateFrom, dateTo: dateToFinal, rateToUsd, action: "created" } });
  }

  async function opDelete(args: { id: number }): Promise<ToolResult> {
    const { id } = args;
    const existing = await q(db, sql`SELECT id, currency, date_from, date_to FROM fx_overrides WHERE id = ${id} AND user_id = ${userId}`);
    if (!existing.length) return err(`FX override #${id} not found`);
    await db.execute(sql`DELETE FROM fx_overrides WHERE id = ${id} AND user_id = ${userId}`);
    const r = existing[0];
    return text({ success: true, data: { id, message: `Deleted FX override for ${r.currency} (${r.date_from}${r.date_to ? `..${r.date_to}` : "+"})` } });
  }

  registerManageTool(
    server,
    "manage_fx_overrides",
    "Manage manual FX rate overrides: `op` selects set / delete / list. set: pin a rate (1 `from` = `rate` `to` on `date`; one side MUST be USD). delete: remove an override by `id`. list: all overrides (rate_to_usd per currency + date range). For a one-off rate/conversion use get_fx_rate / convert_amount instead.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("set"),
        from: z.string().describe("Source currency (e.g. USD)"),
        to: z.string().describe("Target currency (e.g. CAD)"),
        date: ymdDate.describe("YYYY-MM-DD"),
        rate: z.number().positive().describe("Exchange rate — 1 {from} = rate {to}"),
        dateTo: ymdDate.optional().describe("Optional end date YYYY-MM-DD; defaults to a single-day override"),
        note: z.string().optional().describe("Optional note (e.g. 'bank rate at Wise on this day')"),
      }),
      z.object({
        op: z.literal("delete"),
        id: z.number().describe("fx_overrides row id"),
      }),
      z.object({
        op: z.literal("list").describe("List all FX overrides."),
      }),
    ]),
    async (input) => {
      switch (input.op) {
        case "set":
          return opSet(input);
        case "delete":
          return opDelete(input);
        case "list":
          return opList();
      }
    },
  );

  // ── hidden back-compat aliases (removed in v4.1) ─────────────────────────────
  registerAlias(
    server,
    "list_fx_overrides",
    "List the user's manual FX rate overrides. Each override pins rate_to_usd for a currency over a date range; lookup uses the most-specific match.",
    {},
    async () => opList(),
  );
  registerAlias(
    server,
    "set_fx_override",
    "Pin a manual FX rate. Accepts the user-friendly pair shape (1 `from` = `rate` `to` on `date`) and stores it as a rate_to_usd entry under fx_overrides. One side of the pair MUST be USD; cross-pair overrides should be entered as two USD-anchored rows.",
    {
      from: z.string().describe("Source currency (e.g. USD)"),
      to: z.string().describe("Target currency (e.g. CAD)"),
      date: ymdDate.describe("YYYY-MM-DD"),
      rate: z.number().positive().describe("Exchange rate — 1 {from} = rate {to}"),
      dateTo: ymdDate.optional().describe("Optional end date YYYY-MM-DD; defaults to a single-day override"),
      note: z.string().optional().describe("Optional note (e.g. 'bank rate at Wise on this day')"),
    },
    async (args) => opSet(args),
  );
  registerAlias(
    server,
    "delete_fx_override",
    "Delete a manual FX rate override by id",
    { id: z.number().describe("fx_overrides row id") },
    async (args) => opDelete(args),
  );


  // ── convert_amount ────────────────────────────────────────────────────────
  server.tool(
    "convert_amount",
    "Convert an amount from one currency to another using triangulated FX rates. Cross-rates go through USD; user overrides win when they cover the requested date.",
    {
      amount: z.number().describe("Amount to convert"),
      from: z.string().describe("Source currency"),
      to: z.string().describe("Target currency"),
      date: ymdDate.optional().describe("YYYY-MM-DD — defaults to today"),
    },
    async ({ amount, from, to, date }) => {
      // Issue #206 — validate currencies + date at the MCP boundary.
      let fromCode: string;
      let toCode: string;
      let d: string;
      try {
        fromCode = validateCurrencyCode(from);
        toCode = validateCurrencyCode(to);
        d = validateFxDate(date ?? new Date().toISOString().split("T")[0]);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      if (fromCode === toCode) {
        return text({ success: true, data: { amount, from: fromCode, to: toCode, rate: 1, converted: amount, source: "identity" } });
      }
      // Issue #231 — resolve each leg explicitly (matching get_fx_rate) so we
      // can surface per-leg `source`/`effectiveDate` and collapse to the
      // worst-case top-level `source`. Previously this returned a flat
      // "triangulated" label that hid stale fallback legs.
      const fromLookup = await getRateToUsdDetailed(fromCode, d, userId);
      const toLookup = await getRateToUsdDetailed(toCode, d, userId);
      if (toLookup.rate === 0) return err(`Cannot convert into ${toCode} (rate is zero)`);
      const rate = fromLookup.rate / toLookup.rate;
      // Issue #208 — `converted` is a money amount (target-currency precision);
      // `rate` is a divisor (8dp, bank standard). Helpers name the contract.
      const converted = roundMoney(amount * rate, toCode);
      const ratePrecise = roundFxRate(rate);
      const collapsedSource = collapseLegSources([fromLookup, toLookup]);
      const effectiveDate =
        fromLookup.effectiveDate < toLookup.effectiveDate
          ? fromLookup.effectiveDate
          : toLookup.effectiveDate;
      return text({ success: true, data: {
        amount, from: fromCode, to: toCode,
        rate: ratePrecise, converted, date: d,
        source: collapsedSource,
        effectiveDate,
        legs: {
          from: { ...fromLookup, currency: fromCode },
          to: { ...toLookup, currency: toCode },
        },
      } });
    }
  );
}
