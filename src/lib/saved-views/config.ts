/**
 * Saved reports and saved Transactions views (GH #427): the config each one
 * stores, and how a saved date range turns into dates on the day it is opened.
 *
 * Pure (zod only), client-safe: the Reports and Transactions pages build and
 * apply configs with it, the server store (store.ts) validates with it, and the
 * MCP `get_saved_views` tool resolves dates with it.
 *
 * Relative ranges stay relative: a preset is stored by its key ("last-12") and
 * resolved by `resolveSavedDateRange` when the view is opened, so "Last 12
 * Months" still means the last 12 months next year. Only a custom range stores
 * fixed dates.
 */
import { z } from "zod";
import { REPORT_PERIODS, isReportDate } from "@/lib/reports/period";
import {
  REPORT_DATE_PRESETS,
  REPORT_DATE_PRESET_LABELS,
  getPresetRange,
  type ReportDatePreset,
} from "@/lib/reports/presets";
import { COLUMN_IDS, SORTABLE_COLUMN_IDS } from "@/lib/transactions/columns";
import { txColumnFiltersSchema } from "@/lib/transactions/col-filter-schema";

export const SAVED_VIEW_KINDS = ["report", "transactions"] as const;
export type SavedViewKind = (typeof SAVED_VIEW_KINDS)[number];

export function isSavedViewKind(value: unknown): value is SavedViewKind {
  return typeof value === "string" && (SAVED_VIEW_KINDS as readonly string[]).includes(value);
}

/** Longest name a saved view may have. */
export const SAVED_VIEW_NAME_MAX = 80;
/** Saved views per user per kind. */
export const SAVED_VIEWS_MAX_PER_KIND = 100;
/** Largest stored config (JSON characters, before encryption). */
export const SAVED_VIEW_CONFIG_MAX_CHARS = 16_000;

/** Trimmed name, or an error message. */
export function checkSavedViewName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "Give it a name." };
  if (name.length > SAVED_VIEW_NAME_MAX) {
    return { ok: false, error: `Use a name of at most ${SAVED_VIEW_NAME_MAX} characters.` };
  }
  return { ok: true, name };
}

// ── Date ranges ──────────────────────────────────────────────────────────

const reportDate = z.string().refine(isReportDate, "Use a real date (YYYY-MM-DD).");

const presetRange = z.object({ kind: z.literal("preset"), preset: z.enum(REPORT_DATE_PRESETS) });

/** A report's range: a preset, or two fixed dates. */
export const reportDateRangeSchema = z.discriminatedUnion("kind", [
  presetRange,
  z.object({ kind: z.literal("custom"), start: reportDate, end: reportDate }),
]);

/** A Transactions view's range: a preset, or fixed dates where either end may be open. */
export const transactionsDateRangeSchema = z.discriminatedUnion("kind", [
  presetRange,
  z.object({ kind: z.literal("custom"), start: reportDate.optional(), end: reportDate.optional() }),
]);

export type SavedDateRange =
  | { kind: "preset"; preset: ReportDatePreset }
  | { kind: "custom"; start?: string; end?: string };

/**
 * The dates a saved range means on `now` (default: today). An open end of a
 * custom range comes back as "" (no limit).
 */
export function resolveSavedDateRange(range: SavedDateRange, now?: Date): { start: string; end: string } {
  if (range.kind === "preset") return getPresetRange(range.preset, now);
  return { start: range.start ?? "", end: range.end ?? "" };
}

/** A short description: "Last 12 Months", "2026-01-01 to 2026-03-31", "Any date". */
export function describeSavedDateRange(range: SavedDateRange): string {
  if (range.kind === "preset") return REPORT_DATE_PRESET_LABELS[range.preset];
  if (range.start && range.end) return `${range.start} to ${range.end}`;
  if (range.start) return `From ${range.start}`;
  if (range.end) return `Until ${range.end}`;
  return "Any date";
}

/**
 * The range to store when saving changes to a view whose range was `previous`:
 * a preset is kept while the page still shows exactly that preset's dates
 * (so updating a "Last 12 Months" view keeps it relative), anything else is
 * stored as the dates shown.
 */
export function rangeForDates(
  start: string,
  end: string,
  previous?: SavedDateRange | null,
  now?: Date,
): SavedDateRange {
  if (previous?.kind === "preset") {
    const r = getPresetRange(previous.preset, now);
    if (r.start === start && r.end === end) return previous;
  }
  return {
    kind: "custom",
    ...(isReportDate(start) ? { start } : {}),
    ...(isReportDate(end) ? { end } : {}),
  };
}

// ── Report config ────────────────────────────────────────────────────────

export const REPORT_TABS = ["income", "balance", "cashflow", "yoy"] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

export const REPORT_TAB_LABELS: Record<ReportTab, string> = {
  income: "Income Statement",
  balance: "Balance Sheet",
  cashflow: "Cash Flow",
  yoy: "Year over Year",
};

const year = z.number().int().min(1970).max(2200);

export const reportViewConfigSchema = z.object({
  tab: z.enum(REPORT_TABS),
  date: reportDateRangeSchema,
  period: z.enum(REPORT_PERIODS),
  groupBy: z.enum(["category", "group"]),
  /** Empty = every account. */
  accountIds: z.array(z.number().int().positive()).max(500).default([]),
  /** One tag (exact match), or null for no tag filter. */
  tag: z.string().trim().max(200).nullable().default(null).transform((t) => (t ? t : null)),
  business: z.boolean().default(false),
  /** Year over Year years; null = last year against this year, whenever opened. */
  yoy: z.object({ year1: year, year2: year }).nullable().default(null),
});

export type ReportViewConfig = z.infer<typeof reportViewConfigSchema>;

// ── Transactions config ──────────────────────────────────────────────────

const idString = z
  .string()
  .max(20)
  .regex(/^\d*$/, "Use an id.")
  .default("");

// GH #454 — the category picker also takes "none" ("(Blank)": no category).
const categoryIdString = z
  .string()
  .max(20)
  .regex(/^(\d*|none)$/, "Use an id.")
  .default("");

export const transactionsViewConfigSchema = z.object({
  date: transactionsDateRangeSchema,
  accountId: idString,
  categoryId: categoryIdString,
  search: z.string().max(200).default(""),
  portfolioHolding: z.string().max(200).default(""),
  tag: z.string().max(200).default(""),
  sort: z
    .object({
      columnId: z.enum(SORTABLE_COLUMN_IDS).nullable(),
      direction: z.enum(["asc", "desc"]).nullable(),
    })
    .default({ columnId: null, direction: null }),
  colFilters: txColumnFiltersSchema.default([]),
  /** Column order and visibility; null leaves the user's current columns alone. */
  columns: z
    .array(z.object({ id: z.enum(COLUMN_IDS), visible: z.boolean() }))
    .max(COLUMN_IDS.length)
    .nullable()
    .default(null),
  view: z.enum(["list", "calendar"]).default("list"),
  calMode: z.enum(["week", "month", "year"]).default("month"),
});

export type TransactionsViewConfig = z.infer<typeof transactionsViewConfigSchema>;

export type SavedViewConfig = ReportViewConfig | TransactionsViewConfig;

/** The schema for a kind's config. */
export function configSchemaFor(kind: SavedViewKind) {
  return kind === "report" ? reportViewConfigSchema : transactionsViewConfigSchema;
}

/** Validate a config for `kind`: the normalized config, or the first problem. */
export function parseSavedViewConfig(
  kind: SavedViewKind,
  raw: unknown,
): { ok: true; config: SavedViewConfig } | { ok: false; error: string } {
  const parsed = configSchemaFor(kind).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `That view's settings aren't valid (${where}${issue?.message ?? "invalid"}).` };
  }
  const json = JSON.stringify(parsed.data);
  if (json.length > SAVED_VIEW_CONFIG_MAX_CHARS) {
    return { ok: false, error: "That view has too many settings to save." };
  }
  return { ok: true, config: parsed.data };
}

/**
 * A saved view's config with its range resolved for `now`: what an assistant
 * or script needs to run it (MCP `get_saved_views`).
 */
export function resolveSavedViewDates(
  config: SavedViewConfig,
  now?: Date,
): { startDate: string; endDate: string; dateRange: string } {
  const range: SavedDateRange = config.date;
  const { start, end } = resolveSavedDateRange(range, now);
  return { startDate: start, endDate: end, dateRange: describeSavedDateRange(range) };
}

/** One saved view as the store returns it (also the REST shape). */
export interface SavedView {
  id: number;
  kind: SavedViewKind;
  /** "" when unreadable. */
  name: string;
  /** null when unreadable, or when the stored settings no longer validate. */
  config: SavedViewConfig | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** True when this key can't decrypt the view (no key, or written under another key). */
  unreadable: boolean;
}

/** Where a saved view opens in the web app. */
export function savedViewPath(kind: SavedViewKind, id: number): string {
  return `${kind === "report" ? "/reports" : "/transactions"}?savedView=${id}`;
}
