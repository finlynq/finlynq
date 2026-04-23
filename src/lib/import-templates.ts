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

  // Prefer exact-match headers first (e.g. "Date" beats "Transaction Date When Posted").
  const findExact = (keywords: string[]): string | undefined => {
    for (const kw of keywords) {
      const idx = lower.findIndex((h) => h === kw);
      if (idx >= 0) return headers[idx];
    }
    return undefined;
  };

  const findContains = (keywords: string[]): string | undefined => {
    for (const kw of keywords) {
      const idx = lower.findIndex((h) => h.includes(kw));
      if (idx >= 0) return headers[idx];
    }
    return undefined;
  };

  const date =
    findExact(["date", "transaction date", "trans date", "posted date", "post date"]) ??
    findContains(["transaction date", "trans date", "posted", "post date", "date"]);

  // Amount: standard names first, then currency-suffixed columns (CAD$, USD$, $),
  // then debit/credit/value as last resort.
  const amount =
    findExact(["amount", "transaction amount", "amount (cad)", "amount (usd)"]) ??
    findContains(["amount"]) ??
    findContains(["cad$", "usd$", "eur$", "gbp$"]) ??
    findExact(["$", "cad", "usd", "eur", "gbp"]) ??
    findContains(["debit", "credit", "value", "total"]);

  if (!date || !amount) return null;

  // Account: exact-match only — "Account Type" / "Account Number" are bank metadata,
  // not the user's account name in our DB, so don't auto-bind them.
  const account = findExact(["account", "account name"]);

  const payee =
    findExact(["payee", "description", "merchant", "name", "memo", "narrative"]) ??
    findContains(["description", "merchant", "payee", "narrative", "memo"]);

  return {
    date,
    amount,
    account,
    payee,
    category: findContains(["category", "categorization", "class"]),
    currency: findExact(["currency", "ccy"]) ?? findContains(["currency"]),
    note: findExact(["note", "notes", "reference", "ref"]) ?? findContains(["note", "reference"]),
    tags: findExact(["tags", "labels", "label"]) ?? findContains(["tags", "labels"]),
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
