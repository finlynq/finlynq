/**
 * MCP HTTP — tax lots (2026-10-13).
 *
 * One consolidated tool, `manage_lots`, exposing what the web app's Portfolio
 * page and Lot inspector already do:
 *
 *   status    which cost-basis method the user is on + how complete their lots are
 *   set_mode  switch between the simple average and advanced lot allocation
 *   list      a holding's lots and the closures (sales) that consumed them
 *   reassign  change which lots ONE sale was matched against (preview by default)
 *   rebuild   replay a position's trades in date order to rebuild its lots
 *
 * Every op is a thin wrapper over the same library function the web route
 * calls, so an assistant and the screen cannot disagree. Lot writes never
 * touch a `transactions` row.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { text, err, type PgToolContext } from "./_shared";
import { registerManageTool } from "./_consolidate";
import {
  getLotAllocationStatus,
  setLotAllocationEnabled,
  type LotAllocationStatus,
} from "../../src/lib/portfolio/lots/allocation-mode";
import { loadHoldingLotsAndClosures, resolvePositionScope } from "../../src/lib/portfolio/lots/inspect";
import { reassignClosureLots } from "../../src/lib/portfolio/lots/write-hooks";
import { reassignErrorMessage } from "../../src/lib/portfolio/lots/reassign-errors";
import { rebuildLotsForPosition } from "../../src/lib/portfolio/lots/backfill";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The status payload, with the two methods spelled out for the assistant. */
function describeStatus(s: LotAllocationStatus) {
  return {
    mode: s.enabled ? "advanced_lot_allocation" : "simple_average",
    positions: s.positions,
    positionsWithoutLots: s.withoutLots,
    positionsWhereLotsDoNotAddUp: s.mismatched,
    explanation: s.enabled
      ? "Cost basis and gains come from the lots still held. Each sale is matched to specific lots (first in, first out unless changed with op:'reassign')."
      : "Cost basis is the average price of EVERY purchase in a holding, including shares already sold. Lots are still recorded; op:'set_mode' with advanced:true switches the figures over to them.",
  };
}

export function registerLotsTools(server: McpServer, ctx: PgToolContext) {
  const { userId, dek } = ctx;

  async function opList(args: { holding_id: number; account_id?: number }): Promise<ToolResult> {
    const { lots, closures } = await loadHoldingLotsAndClosures(userId, args.holding_id, args.account_id ?? null);
    if (lots.length === 0) {
      return err(
        `No lots found for holding #${args.holding_id}. Either it is not one of this user's holdings or it has no lots yet (op:'rebuild' builds them from its trades).`,
      );
    }
    const open = lots.filter((l) => l.status === "open" && l.qtyRemaining > 0);
    return text({
      success: true,
      data: {
        holdingId: args.holding_id,
        // What is still held, per lot. Its total is the lot-based cost basis.
        openLots: open.map((l) => ({
          lotId: l.id,
          accountId: l.accountId,
          side: l.side,
          openDate: l.openDate,
          qtyRemaining: l.qtyRemaining,
          qtyOriginal: l.qtyOriginal,
          costPerShare: l.costPerShare,
          costBasis: round2(l.qtyRemaining * l.costPerShare),
          currency: l.currency,
          openTxId: l.openTxId,
        })),
        openQty: open.reduce((s, l) => s + (l.side === "short" ? -l.qtyRemaining : l.qtyRemaining), 0),
        openCostBasis: round2(open.reduce((s, l) => s + (l.side === "short" ? -1 : 1) * l.qtyRemaining * l.costPerShare, 0)),
        // Every sale and the lot it was matched against. `closeTxId` is what
        // op:'reassign' takes to change that matching.
        closures: closures.map((c) => ({
          closeTxId: c.closeTxId,
          closeDate: c.closeDate,
          closeKind: c.closeKind,
          lotId: c.lotId,
          qtyClosed: c.qtyClosed,
          costPerShare: c.costPerShare,
          proceedsPerShare: c.proceedsPerShare,
          realizedGain: c.realizedGain,
          currency: c.currency,
          ...(c.openAfterClose ? { warning: "This lot opened AFTER the sale, the sign of trades entered out of date order. op:'rebuild' fixes it." } : {}),
        })),
        allLots: lots.length,
      },
    });
  }

  async function opReassign(args: {
    holding_id: number;
    close_tx_id: number;
    per_lot_qty: Array<{ lot_id: number; qty: number }>;
    preview?: boolean;
  }): Promise<ToolResult> {
    if (!dek) return err("Reassigning lots needs an unlocked DEK.");
    const dryRun = args.preview !== false; // preview unless told otherwise
    const result = await reassignClosureLots(
      userId,
      {
        holdingId: args.holding_id,
        closeTxId: args.close_tx_id,
        perLotQty: args.per_lot_qty.map((p) => ({ lotId: p.lot_id, qty: p.qty })),
      },
      { dryRun, dek },
    );
    if (!result.ok) return err(reassignErrorMessage(result));
    return text({
      success: true,
      data: {
        committed: !dryRun,
        preview: result.preview,
        message: dryRun
          ? "Preview only, nothing was changed. Call again with preview:false to apply it."
          : "The sale is now matched against the chosen lots. Only its own realized gain changed; no transaction was touched.",
      },
    });
  }

  async function opRebuild(args: { holding_id: number; confirm_reset?: boolean }): Promise<ToolResult> {
    if (!dek) return err("Rebuilding lots needs an unlocked DEK.");
    const scope = await resolvePositionScope(userId, args.holding_id);
    if (!scope) return err(`Holding #${args.holding_id} not found`);
    if (args.confirm_reset !== true) {
      return err(
        "A rebuild replays this position's trades in date order and matches every sale first in, first out. Any matching chosen by hand for this position is reset. Transactions are not changed. Call again with confirm_reset:true to proceed.",
      );
    }
    const result = await rebuildLotsForPosition(userId, dek, scope);
    return text({
      success: true,
      data: {
        holdingIds: scope.holdingIds,
        accountId: scope.accountId,
        lotsWritten: result.lotsWritten,
        closuresWritten: result.closuresWritten,
        tradesReplayed: result.txProcessed,
        // Non-fatal: a sale larger than the shares held, a cross-account transfer.
        warnings: result.errors,
      },
    });
  }

  registerManageTool(
    server,
    "manage_lots",
    "Manage tax lots and the cost-basis method; `op`: status, set_mode, list, reassign, rebuild. status: which method the user is on (simple average of every purchase, or advanced lot allocation) and whether every position has lots. set_mode: switch method (`advanced` true/false); lots and hand-made matching are kept either way. list: a holding's open lots (the lot-based cost basis) and every sale with the lot it was matched to. reassign: change which lots ONE sale consumed; previews unless preview:false; quantities must total the sale; same account only; only lots bought on or before the sale date. rebuild: replay a position's trades in date order, first in first out; resets hand-made matching for that position, so it needs confirm_reset:true. No op changes a transaction. Find holding ids with get_portfolio_analysis.",
    z.discriminatedUnion("op", [
      z.object({
        op: z.literal("status").describe("Which cost-basis method the user is on, and lot coverage."),
      }),
      z.object({
        op: z.literal("set_mode"),
        advanced: z.boolean().describe("true: advanced lot allocation (cost basis from the lots still held). false: the simple average of every purchase."),
      }),
      z.object({
        op: z.literal("list"),
        holding_id: z.number().int().positive().describe("Holding id (see get_portfolio_analysis)"),
        account_id: z.number().int().positive().optional().describe("Limit to one account's lots"),
      }),
      z.object({
        op: z.literal("reassign"),
        holding_id: z.number().int().positive().describe("Holding id the sale belongs to"),
        close_tx_id: z.number().int().positive().describe("The sale's transaction id (`closeTxId` from op:'list')"),
        per_lot_qty: z
          .array(
            z.object({
              lot_id: z.number().int().positive().describe("A lot of the same holding and account, bought on or before the sale date (`lotId` from op:'list'). A lot bought later is refused, except one the sale already uses, which may keep at most what it takes now"),
              qty: z.number().positive().describe("Shares of the sale to take from that lot"),
            }),
          )
          .min(1)
          .describe("How the sale's shares are split across lots. The quantities must total the sale's quantity."),
        preview: z.boolean().optional().describe("Default true: show the result and change nothing. false: apply it."),
      }),
      z.object({
        op: z.literal("rebuild"),
        holding_id: z.number().int().positive().describe("Any holding of the position to rebuild"),
        confirm_reset: z.boolean().optional().describe("Must be true: the rebuild resets hand-made matching for this position."),
      }),
    ]),
    async (input) => {
      switch (input.op) {
        case "status":
          return text({ success: true, data: describeStatus(await getLotAllocationStatus(userId)) });
        case "set_mode": {
          const s = await setLotAllocationEnabled(userId, dek, input.advanced);
          return text({
            success: true,
            data: {
              ...describeStatus(s),
              positionsBuiltWhileSwitching: s.rebuilt,
              ...(s.mismatched > 0
                ? { note: `${s.mismatched} position(s) have lots that do not add up to the shares held. op:'rebuild' on each fixes them.` }
                : {}),
            },
          });
        }
        case "list":
          return opList(input);
        case "reassign":
          return opReassign(input);
        case "rebuild":
          return opRebuild(input);
      }
    },
  );
}
