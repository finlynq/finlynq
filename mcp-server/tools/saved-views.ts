/**
 * MCP HTTP — saved reports and saved Transactions views (GH #427).
 *
 *   get_saved_views  (read)  the user's saved views with their settings and
 *                            the date range each one means TODAY (a preset
 *                            such as "Last 12 Months" is stored relative and
 *                            resolved here), so an assistant can run a saved
 *                            report by name with the read tools.
 *
 * Named `get_*`, not `manage_*`: the OAuth scope gate and the toolsets
 * classify read tools by NAME PREFIX (src/lib/mcp/toolsets.ts), and a
 * `manage_*` name would put this read behind `mcp:write`. Saving, renaming
 * and deleting views stays in the web app.
 *
 * A thin wrapper over src/lib/saved-views/store.ts (the store the Reports and
 * Transactions pages use). Names and settings are encrypted, so it needs the
 * user's key.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { text, err, type PgToolContext } from "./_shared";
import { findSavedViewByName, listSavedViews } from "../../src/lib/saved-views/store";
import {
  SAVED_VIEW_KINDS,
  REPORT_TAB_LABELS,
  resolveSavedViewDates,
  savedViewPath,
  type ReportViewConfig,
  type SavedView,
  type TransactionsViewConfig,
} from "../../src/lib/saved-views/config";
import { todayISO } from "../../src/lib/utils/date";

const LOCKED =
  "The user's saved views are encrypted and this session has no unlocked key, so they can't be read right now. Ask the user to sign in to Finlynq again.";

/** Which read tool reproduces a view, in one line. */
function howToRun(view: SavedView, dates: { startDate: string; endDate: string }): string {
  if (view.kind === "report") {
    const c = view.config as ReportViewConfig;
    if (c.tab === "balance") return `get_net_worth or get_account_balances (balances on ${dates.endDate}).`;
    const tagNote = c.tag ? ` Only transactions tagged "${c.tag}" count: use search_transactions with tags="${c.tag}" for them.` : "";
    return `get_income_statement with start_date=${dates.startDate} and end_date=${dates.endDate}.${tagNote}`;
  }
  const c = view.config as TransactionsViewConfig;
  const parts = [
    dates.startDate ? `start_date=${dates.startDate}` : null,
    dates.endDate ? `end_date=${dates.endDate}` : null,
    c.accountId ? `account_id=${c.accountId}` : null,
    c.tag ? `tags="${c.tag}"` : null,
    c.search ? `payee="${c.search}"` : null,
  ].filter(Boolean);
  return `search_transactions${parts.length ? ` with ${parts.join(", ")}` : ""}.`;
}

export function registerSavedViewsTools(server: McpServer, ctx: PgToolContext) {
  const { userId, dek } = ctx;

  server.tool(
    "get_saved_views",
    "List the user's saved reports and saved Transactions views, with each one's settings and the dates it covers today. Relative ranges (Last 12 Months, Year to Date) are resolved for today's date, so a saved report can be run by name: pass `name` to get one, or `kind` to list only reports or only Transactions views. Each view says which read tool reproduces it. Views are saved, renamed and deleted in the web app.",
    {
      kind: z.enum(SAVED_VIEW_KINDS).optional().describe("report or transactions; omit for both"),
      name: z.string().max(200).optional().describe("A view's name (not case-sensitive)"),
    },
    async ({ kind, name }) => {
      if (!dek) return err(LOCKED);
      const views = name ? await findSavedViewByName(userId, dek, kind, name) : await listSavedViews(userId, dek, kind);
      if (name && views.length === 0) {
        return err(`No saved view called "${name}". Call get_saved_views with no arguments to see them all.`);
      }
      const out = views.map((v) => {
        if (v.unreadable || !v.config) {
          return { id: v.id, kind: v.kind, name: v.name || null, unreadable: true };
        }
        const dates = resolveSavedViewDates(v.config);
        return {
          id: v.id,
          kind: v.kind,
          name: v.name,
          ...(v.kind === "report" ? { tab: REPORT_TAB_LABELS[(v.config as ReportViewConfig).tab] } : {}),
          ...(v.kind === "transactions" ? { isDefault: v.isDefault } : {}),
          dateRange: dates.dateRange,
          startDate: dates.startDate || null,
          endDate: dates.endDate || null,
          config: v.config,
          path: savedViewPath(v.kind, v.id),
          howToRun: howToRun(v, dates),
        };
      });
      return text({ success: true, data: { asOf: todayISO(), views: out } });
    },
  );
}
