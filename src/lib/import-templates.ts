/**
 * Import template matching and CSV parsing utilities.
 * Templates store CSV header signatures and column mappings so users
 * can re-import from the same bank format without re-mapping each time.
 */

export interface ColumnMapping {
  date: string;
  amount: string;
  account?: string;
  payee?: string;
  category?: string;
  currency?: string;
  note?: string;
  tags?: string;
}

export interface ImportTemplate {
  id: number;
  userId: string;
  name: string;
  fileHeaders: string[];
  columnMapping: ColumnMapping;
  defaultAccount?: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Score how well a set of file headers matches a saved template (0–100). */
export function scoreTemplateMatch(fileHeaders: string[], templateHeaders: string[]): number {
  if (templateHeaders.length === 0) return 0;

  const fileSet = new Set(fileHeaders.map((h) => h.toLowerCase().trim()));
  let matched = 0;
  for (const h of templateHeaders) {
    if (fileSet.has(h.toLowerCase().trim())) matched++;
  }
  return Math.round((matched / templateHeaders.length) * 100);
}

/** Find the best matching template for given headers. Requires ≥ 80% overlap. */
export function findBestTemplate(
  fileHeaders: string[],
  templates: ImportTemplate[],
): { template: ImportTemplate; score: number } | null {
  let best: { template: ImportTemplate; score: number } | null = null;

  for (const t of templates) {
    const score = scoreTemplateMatch(fileHeaders, t.fileHeaders);
    if (score >= 80 && (!best || score > best.score)) {
      best = { template: t, score };
    }
  }

  return best;
}

/** Auto-detect column mapping from CSV headers using keyword matching. */
export function autoDetectColumnMapping(headers: string[]): ColumnMapping | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const find = (keywords: string[]) =>
    headers[lower.findIndex((h) => keywords.some((k) => h.includes(k)))] ?? undefined;

  const date = find(["date", "posted", "transaction date", "trans date"]);
  const amount = find(["amount", "debit", "credit", "total", "value"]);

  if (!date || !amount) return null;

  return {
    date,
    amount,
    account: find(["account"]),
    payee: find(["payee", "description", "merchant", "name", "memo", "narrative"]),
    category: find(["category", "categorization", "type", "class"]),
    currency: find(["currency", "ccy"]),
    note: find(["note", "reference", "ref", "memo"]),
    tags: find(["tags", "labels", "label"]),
  };
}

/** Parse a raw DB row from import_templates into ImportTemplate. */
export function deserializeTemplate(row: {
  id: number;
  userId: string;
  name: string;
  fileHeaders: string;
  columnMapping: string;
  defaultAccount?: string | null;
  isDefault: number;
  createdAt: string;
  updatedAt: string;
}): ImportTemplate {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    fileHeaders: JSON.parse(row.fileHeaders) as string[],
    columnMapping: JSON.parse(row.columnMapping) as ColumnMapping,
    defaultAccount: row.defaultAccount ?? null,
    isDefault: row.isDefault === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
