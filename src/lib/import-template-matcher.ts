/**
 * Import Template Matcher
 *
 * Compares CSV file headers against saved import templates and returns
 * a match score (0–100) for each template. Higher = better match.
 */

export interface ColumnMapping {
  date?: string;
  amount?: string;
  payee?: string;
  category?: string;
  note?: string;
  tags?: string;
  currency?: string;
  debit?: string;
  credit?: string;
}

export interface ImportTemplate {
  id: number;
  userId: string;
  name: string;
  accountId: number | null;
  fileType: string;
  columnMapping: string; // JSON-serialized ColumnMapping
  hasHeaders: number;
  dateFormat: string;
  amountFormat: string;
  isDefault: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateMatchResult {
  template: ImportTemplate;
  score: number; // 0–100
  matchedColumns: string[];
  missingColumns: string[];
}

/**
 * Score how well a set of file headers matches a saved template.
 *
 * Strategy: the template's column mapping records which CSV header names
 * the user previously mapped to each logical field. We check what fraction
 * of those header names appear (case-insensitively) in the file being uploaded.
 *
 * Required fields (date + amount/debit+credit) carry extra weight.
 */
export function scoreTemplateMatch(
  fileHeaders: string[],
  template: ImportTemplate
): TemplateMatchResult {
  let mapping: ColumnMapping = {};
  try {
    mapping = JSON.parse(template.columnMapping) as ColumnMapping;
  } catch {
    return { template, score: 0, matchedColumns: [], missingColumns: [] };
  }

  const normalizedHeaders = fileHeaders.map((h) => h.trim().toLowerCase());

  // Collect non-empty mapped column names with their weight
  const mappedEntries: Array<{ logical: string; csvColumn: string; weight: number }> = [];

  const weights: Record<string, number> = {
    date: 3,
    amount: 3,
    debit: 2,
    credit: 2,
    payee: 2,
    category: 1,
    note: 1,
    tags: 1,
    currency: 1,
  };

  for (const [logical, csvColumn] of Object.entries(mapping)) {
    if (csvColumn && csvColumn.trim()) {
      mappedEntries.push({
        logical,
        csvColumn: csvColumn.trim(),
        weight: weights[logical] ?? 1,
      });
    }
  }

  if (mappedEntries.length === 0) {
    return { template, score: 0, matchedColumns: [], missingColumns: [] };
  }

  const matchedColumns: string[] = [];
  const missingColumns: string[] = [];
  let weightedMatches = 0;
  let totalWeight = 0;

  for (const entry of mappedEntries) {
    totalWeight += entry.weight;
    if (normalizedHeaders.includes(entry.csvColumn.toLowerCase())) {
      weightedMatches += entry.weight;
      matchedColumns.push(entry.csvColumn);
    } else {
      missingColumns.push(entry.csvColumn);
    }
  }

  const score = totalWeight > 0 ? Math.round((weightedMatches / totalWeight) * 100) : 0;
  return { template, score, matchedColumns, missingColumns };
}

/**
 * Rank all templates against the given file headers.
 * Returns results sorted by score descending.
 */
export function rankTemplates(
  fileHeaders: string[],
  templates: ImportTemplate[]
): TemplateMatchResult[] {
  return templates
    .map((t) => scoreTemplateMatch(fileHeaders, t))
    .sort((a, b) => b.score - a.score);
}

/**
 * Apply a template's column mapping to a parsed CSV row, returning a
 * normalized record with logical field names (date, amount, payee, …).
 */
export function applyTemplateMapping(
  row: Record<string, string>,
  mapping: ColumnMapping,
  amountFormat: string
): {
  date: string;
  amount: number;
  payee: string;
  category: string;
  note: string;
  tags: string;
  currency: string;
} {
  const get = (col: string | undefined) => (col ? (row[col] ?? "") : "");

  const rawDate = get(mapping.date);
  const rawPayee = get(mapping.payee);
  const rawCategory = get(mapping.category);
  const rawNote = get(mapping.note);
  const rawTags = get(mapping.tags);
  const rawCurrency = get(mapping.currency);

  let amount = 0;
  if (amountFormat === "debit_credit") {
    const debit = parseFloat(get(mapping.debit).replace(/[^0-9.-]/g, "")) || 0;
    const credit = parseFloat(get(mapping.credit).replace(/[^0-9.-]/g, "")) || 0;
    // Convention: debit reduces balance (negative), credit increases (positive)
    amount = credit - debit;
  } else {
    const raw = get(mapping.amount).replace(/[^0-9.-]/g, "");
    amount = parseFloat(raw) || 0;
    if (amountFormat === "negate") amount = -amount;
  }

  return {
    date: rawDate,
    amount,
    payee: rawPayee,
    category: rawCategory,
    note: rawNote,
    tags: rawTags,
    currency: rawCurrency,
  };
}
