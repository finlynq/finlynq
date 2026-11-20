/**
 * MCP HTTP — manual security prices (GH #394, 2026-11-20).
 *
 * One consolidated tool, `manage_security_prices`, for securities Yahoo
 * Finance and CoinGecko can't price (Argentine BYMA bonds, private funds,
 * a pension fund unit). It does what the Manage prices dialog on
 * Settings → Investments does, plus writing many marks in one call, so an
 * assistant can bring in quotes from another source (for example a broker's
 * own MCP server) without anyone typing prices:
 *
 *   list        the user's securities with their price source and marks, or one
 *               security's marks
 *   set         add or replace marks (one per date), many at once
 *   delete      remove marks by date or id
 *   set_source  'manual' = value from the marks; 'auto' = Yahoo / CoinGecko
 *
 * Every op is a thin wrapper over custom-price-store.ts, the same module the
 * REST route uses. Marks never touch a transaction; history charts rebuild
 * from the earliest date a change affects.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { text, err, type PgToolContext } from "./_shared";
import { registerManageTool } from "./_consolidate";
import { db as appDb, schema } from "../../src/db";
import { decryptName } from "../../src/lib/crypto/encrypted-columns";
import {
  CustomPriceError,
  MAX_MARKS_PER_CALL,
  deleteCustomPrices,
  findUserSecurity,
  listCustomPrices,
  setSecurityPriceSource,
  summarizeCustomPrices,
  upsertCustomPrices,
} from "../../src/lib/securities/custom-price-store";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const AUTO_NOTE =
  "This security is priced automatically (price_source 'auto'), so these marks are stored but not used. op:'set_source' with source:'manual' values it from the marks.";

export function registerSecurityPricesTools(server: McpServer, ctx: PgToolContext) {
  const { userId, dek } = ctx;

  async function opListSecurities(): Promise<ToolResult> {
    const rows = await appDb
      .select({
        id: schema.securities.id,
        symbolCt: schema.securities.symbolCt,
        nameCt: schema.securities.nameCt,
        assetType: schema.securities.assetType,
        currency: schema.securities.currency,
        priceSource: schema.securities.priceSource,
      })
      .from(schema.securities)
      .where(and(eq(schema.securities.userId, userId), eq(schema.securities.isCash, false)));
    const marks = await summarizeCustomPrices(userId);
    return text({
      success: true,
      data: {
        securities: rows
          .map((r) => {
            const m = marks.get(r.id);
            return {
              securityId: r.id,
              symbol: decryptName(r.symbolCt, dek, null),
              name: decryptName(r.nameCt, dek, null),
              assetType: r.assetType,
              currency: r.currency,
              priceSource: r.priceSource === "manual" ? "manual" : "auto",
              marks: m ? { count: m.count, firstDate: m.firstDate, lastDate: m.lastDate } : { count: 0 },
            };
          })
          .sort((a, b) => (a.symbol ?? a.name ?? "").localeCompare(b.symbol ?? b.name ?? "")),
        ...(dek ? {} : { note: "Names and tickers need an unlocked session; they read null here. Ids still work." }),
      },
    });
  }

  async function opListMarks(securityId: number, limit: number): Promise<ToolResult> {
    const sec = await findUserSecurity(userId, securityId);
    if (!sec) return err(`Security #${securityId} not found. op:'list' without security_id lists this user's securities.`);
    const marks = await listCustomPrices(userId, securityId, { limit });
    return text({
      success: true,
      data: {
        securityId,
        currency: sec.currency,
        priceSource: sec.priceSource,
        marks: marks.map((m) => ({ markId: m.id, date: m.date, price: m.price })),
        ...(marks.length === limit ? { note: `Showing the newest ${limit}. Pass a larger limit for more.` } : {}),
        ...(sec.priceSource === "auto" && marks.length > 0 ? { warning: AUTO_NOTE } : {}),
      },
    });
  }

  registerManageTool(
    server,
    "manage_security_prices",
    "Manage manual prices for securities with no Yahoo or CoinGecko price; `op`: list, set, delete, set_source. For example a bond with no Yahoo ticker, or a private fund. list: without security_id, every security with its price source and how many marks it has; with security_id, its marks, newest first. set: add or replace marks, one per date (a date already marked gets the new price), up to 1000 in one call, in the security's own currency. A security is valued at its latest mark on or before each day, and at 0 before its first mark. delete: remove marks by date or mark id. set_source: 'manual' values the security from its marks; 'auto' goes back to Yahoo / CoinGecko. Marks are used only while the source is 'manual'. Create the holding first with manage_holdings or portfolio_record_entry. No op changes a transaction.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("list"),
        security_id: z.number().int().positive().optional().describe("Omit to list every security; give one to see its marks"),
        limit: z.number().int().min(1).max(MAX_MARKS_PER_CALL).optional().describe("Most marks to return for one security (default 100)"),
      }),
      z.object({
        op: z.literal("set"),
        security_id: z.number().int().positive().describe("Security id (`securityId` from op:'list')"),
        prices: z
          .array(
            z.object({
              date: z.string().regex(ISO_DATE, "Date must be YYYY-MM-DD").describe("The day this price applies from (YYYY-MM-DD)"),
              price: z.number().nonnegative().describe("Price per unit, in the security's currency"),
            }),
          )
          .min(1)
          .max(MAX_MARKS_PER_CALL)
          .describe("Marks to add or replace; each date at most once"),
      }),
      z.object({
        op: z.literal("delete"),
        security_id: z.number().int().positive().describe("Security id (`securityId` from op:'list')"),
        dates: z.array(z.string().regex(ISO_DATE, "Date must be YYYY-MM-DD")).max(MAX_MARKS_PER_CALL).optional().describe("Dates of the marks to remove"),
        mark_ids: z.array(z.number().int().positive()).max(MAX_MARKS_PER_CALL).optional().describe("Ids of the marks to remove (`markId` from op:'list')"),
      }),
      z.object({
        op: z.literal("set_source"),
        security_id: z.number().int().positive().describe("Security id (`securityId` from op:'list')"),
        source: z.enum(["manual", "auto"]).describe("'manual': value from the marks. 'auto': Yahoo Finance / CoinGecko."),
      }),
    ]),
    async (input) => {
      try {
        switch (input.op) {
          case "list":
            return input.security_id
              ? opListMarks(input.security_id, input.limit ?? 100)
              : opListSecurities();
          case "set": {
            const { security, written } = await upsertCustomPrices(userId, input.security_id, input.prices);
            const dates = input.prices.map((p) => p.date).sort();
            return text({
              success: true,
              data: {
                securityId: input.security_id,
                written,
                currency: security.currency,
                firstDate: dates[0],
                lastDate: dates[dates.length - 1],
                priceSource: security.priceSource,
                ...(security.priceSource === "auto" ? { warning: AUTO_NOTE } : {}),
              },
            });
          }
          case "delete": {
            if (!input.dates?.length && !input.mark_ids?.length) {
              return err("Give dates or mark_ids to delete.");
            }
            const { deleted } = await deleteCustomPrices(userId, input.security_id, {
              dates: input.dates,
              ids: input.mark_ids,
            });
            return text({ success: true, data: { securityId: input.security_id, deleted } });
          }
          case "set_source": {
            const { security, changed } = await setSecurityPriceSource(userId, input.security_id, input.source);
            const marks = await listCustomPrices(userId, input.security_id, { limit: 1 });
            return text({
              success: true,
              data: {
                securityId: input.security_id,
                priceSource: security.priceSource,
                changed,
                ...(security.priceSource === "manual" && marks.length === 0
                  ? { note: "No marks yet, so the holding is valued at 0 until op:'set' adds one." }
                  : {}),
              },
            });
          }
        }
      } catch (e) {
        if (e instanceof CustomPriceError) return err(e.message);
        throw e;
      }
    },
  );
}
