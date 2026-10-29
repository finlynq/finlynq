/**
 * Matching for the transactions list's encrypted-text filters: `search`,
 * `tag` and the per-column `filter_*` substring filters of
 * GET /api/transactions. Payee, note, tags and account / holding names are
 * encrypted at rest, so these run on decrypted values in memory, never in
 * SQL. Pure (crypto only): the DB scan that feeds it is search-scan.ts.
 */
import { decryptField } from "@/lib/crypto/envelope";
import { filterDecryptedBySearch } from "@/lib/crypto/encrypted-columns";

/** The encrypted-text filters of one request. Unset = not filtering on it. */
export interface TextFilterCriteria {
  /** `search`: payee, note or tags contain it (case-insensitive). */
  search?: string;
  /** `tag`: one of the comma-separated tags equals it exactly. */
  tag?: string;
  /** `filter_*`: that one field contains it (case-insensitive). */
  payee?: string;
  note?: string;
  accountName?: string;
  accountAlias?: string;
  portfolio?: string;
  tags?: string;
}

/** One transaction, decrypted, with just the fields the criteria read. */
export interface TextFilterRow {
  id: number;
  payee: string | null;
  note: string | null;
  tags: string | null;
  accountName: string | null;
  accountAlias: string | null;
  portfolioHolding: string | null;
}

/** The row's own payee / note / tags have to be decrypted. */
export function readsTransactionText(c: TextFilterCriteria): boolean {
  return !!(c.search || c.tag || c.payee || c.note || c.tags);
}

/** Account names / aliases have to be decrypted. */
export function readsAccountNames(c: TextFilterCriteria): boolean {
  return !!(c.accountName || c.accountAlias);
}

/** Holding names have to be decrypted. */
export function readsHoldingNames(c: TextFilterCriteria): boolean {
  return !!c.portfolio;
}

function containsText(value: string | null, needle: string): boolean {
  if (!value) return false;
  return value.toLowerCase().includes(needle.toLowerCase());
}

/** The rows that pass every set criterion (AND across criteria), in order. */
export function filterTextRows(rows: TextFilterRow[], c: TextFilterCriteria): TextFilterRow[] {
  let out = rows;
  if (c.search) out = filterDecryptedBySearch(out, c.search);
  if (c.tag) {
    // Exact match on the comma-split list: a substring would let `source:X`
    // match a `source:XY` tag.
    const tag = c.tag;
    out = out.filter((r) => (r.tags ? r.tags.split(",").map((t) => t.trim()).includes(tag) : false));
  }
  if (c.payee) {
    const needle = c.payee;
    out = out.filter((r) => containsText(r.payee, needle));
  }
  if (c.note) {
    const needle = c.note;
    out = out.filter((r) => containsText(r.note, needle));
  }
  if (c.accountName) {
    const needle = c.accountName;
    out = out.filter((r) => containsText(r.accountName, needle));
  }
  if (c.accountAlias) {
    const needle = c.accountAlias;
    out = out.filter((r) => containsText(r.accountAlias, needle));
  }
  if (c.portfolio) {
    const needle = c.portfolio;
    out = out.filter((r) => containsText(r.portfolioHolding, needle));
  }
  if (c.tags) {
    const needle = c.tags;
    out = out.filter((r) => containsText(r.tags, needle));
  }
  return out;
}

/**
 * The name a transaction's holding is shown under. With the securities
 * read-flip on, the security's name wins (a renamed security, e.g. a cash
 * sleeve "Cash USD", shows its new name); otherwise, or when it can't be
 * decrypted, the position's own name.
 */
export function holdingDisplayName(
  securityNameCt: string | null | undefined,
  holdingNameCt: string | null | undefined,
  dek: Buffer | null,
  securitiesRead: boolean,
  fallback: string | null = null,
): string | null {
  let name: string | null = null;
  if (securitiesRead && securityNameCt && dek) {
    try {
      name = decryptField(dek, securityNameCt);
    } catch {
      name = null;
    }
  }
  if (!name) {
    name = fallback;
    if (!name && holdingNameCt && dek) {
      try {
        name = decryptField(dek, holdingNameCt);
      } catch {
        name = null;
      }
    }
  }
  return name;
}
