/**
 * Zod schema for one per-column filter on the /transactions table (issue #59).
 * Shared by `/api/settings/tx-filters` (the user's current filters) and saved
 * Transactions views (GH #427), so a saved view stores exactly the shape the
 * page holds. Pure (zod + column ids), client-safe.
 *
 * Shape is a discriminated union by `type`:
 *  - `date`     : { from?: string, to?: string }                (YYYY-MM-DD)
 *  - `text`     : { value: string }                             (substring, case-insensitive)
 *  - `numeric`  : { op: 'eq'|'gt'|'lt'|'between', value, value2? }
 *  - `enum`     : { values: string[] }                          (multi-select)
 */
import { z } from "zod";
import { COLUMN_IDS, FILTERABLE_COLUMN_IDS } from "./columns";

const filterableColumnSchema = z.enum(FILTERABLE_COLUMN_IDS as [string, ...string[]]);

export const txColumnFilterSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("date"),
    columnId: filterableColumnSchema,
    from: z.string().trim().min(0).max(20).optional(),
    to: z.string().trim().min(0).max(20).optional(),
  }),
  z.object({
    type: z.literal("text"),
    columnId: filterableColumnSchema,
    value: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("numeric"),
    columnId: filterableColumnSchema,
    op: z.enum(["eq", "gt", "lt", "between"]),
    value: z.number(),
    value2: z.number().optional(),
  }),
  z.object({
    type: z.literal("enum"),
    columnId: filterableColumnSchema,
    // Bounded so the blob stays small; 100 covers every realistic enum
    // (sources, account types, categories).
    values: z.array(z.string().max(200)).min(1).max(100),
  }),
]);

/** Cap on the list: one entry per filterable column is enough for any sane UI. */
export const txColumnFiltersSchema = z.array(txColumnFilterSchema).max(COLUMN_IDS.length * 2);

export type TxColumnFilter = z.infer<typeof txColumnFilterSchema>;
