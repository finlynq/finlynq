/**
 * Duplicate bank-ledger row grouping (FINLYNQ-213, R-06).
 *
 * Pure grouping core for the read-only MCP tool `find_duplicate_bank_rows`.
 * The tool is the thin adapter: it loads `bank_transactions` rows for one
 * account, decrypts `payee` per `encryption_tier` (the same tier-aware branch
 * as `bank-ledger-pool.ts`), and hands the decrypted rows to this function.
 *
 * ## Why `seen_count` is NOT the duplicate signal (load-bearing)
 * Re-importing the SAME economic row (identical `import_hash`) does NOT create
 * a second `bank_transactions` row — `upsertBankTransaction` bumps the existing
 * row's `seen_count` / `last_seen_at` / `source_filenames` instead. So a row
 * with `seen_count > 1` is a single de-duplicated row, not a duplicate.
 *
 * TRUE duplicate ROWS arise when overlapping statement files describe the same
 * economic event but produce DIFFERENT `import_hash` values (e.g. the payee
 * string differs slightly between two banks' exports, or a different date
 * format) — so two DISTINCT ids land for one event. We surface those by
 * grouping DISTINCT row ids that share `(date, amount, normalized payee)`.
 * Exact `import_hash` collisions across distinct ids are a secondary signal
 * folded into the same group when present.
 *
 * Owner-scoping + account-scoping happen at the query boundary (the caller
 * loads only the user's rows for one account); this core is pure over the
 * decrypted rows it is given.
 */

export interface DuplicateBankInputRow {
  /** `bank_transactions.id` — UUID. */
  id: string;
  /** ISO YYYY-MM-DD. */
  date: string;
  /** Signed amount in the account's native currency. */
  amount: number;
  /** Plaintext payee (post tier-aware decrypt). null on auth-tag failure. */
  payeePlain: string | null;
  /** Always set on bank_transactions (NOT NULL column). */
  importHash: string;
  /** `seen_count` — re-import hit counter on this single row (NOT a dup signal). */
  seenCount: number;
  /** `first_seen_at` as an ISO timestamp string. Drives canonical selection. */
  firstSeenAt: string;
  /** Resolved linked tx id (transaction_bank_links primary first, else the
   *  `transactions.bank_transaction_id` FK). null when this row is unlinked. */
  linkedTransactionId: number | null;
}

export interface DuplicateBankGroup {
  /** Oldest row in the group by `first_seen_at` — the one to KEEP. */
  canonicalId: string;
  /** The other row ids in the group — candidates to delete. */
  duplicateIds: string[];
  /** Shared date (YYYY-MM-DD). */
  date: string;
  /** Shared signed amount. */
  amount: number;
  /** Shared (display) payee — the canonical row's payee, "" when undecryptable. */
  payee: string;
  /** Max `seen_count` across the group (informational; NOT the dup signal). */
  seenCount: number;
  /** Populated when ANY row in the group is already linked to a transaction —
   *  helps Claude pick which canonical to keep. Omitted when none are linked. */
  linkedTransactionId?: number;
}

/**
 * Normalize a payee for grouping: trim + collapse internal whitespace +
 * lowercase. null/empty payees normalize to "" so two undecryptable rows for
 * the same date+amount still group (they are still likely the same event).
 */
function normalizePayee(payee: string | null): string {
  if (payee == null) return "";
  return payee.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Group key for the economic event: date + amount + normalized payee. */
function eventKey(row: DuplicateBankInputRow): string {
  // Amount keyed at cent precision to avoid float-formatting drift.
  const amtKey = Math.round(row.amount * 100);
  return `${row.date}|${amtKey}|${normalizePayee(row.payeePlain)}`;
}

/**
 * Compare two ISO timestamp strings; returns true when `a` is strictly older
 * than `b`. Falls back to id ordering at the call site for stable ties.
 */
function isOlder(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}

/**
 * Group distinct bank rows that represent the same economic event.
 *
 * Returns one `DuplicateBankGroup` per `(date, amount, payee)` cluster that
 * contains MORE THAN ONE distinct row id. Clusters with a single row are not
 * duplicates and are dropped. Empty input → `[]`.
 *
 * `canonicalId` = oldest by `firstSeenAt` (ties broken by lexicographic id so
 * the result is deterministic). `linkedTransactionId` is populated from the
 * first linked row found (canonical preferred).
 */
export function findDuplicateBankRows(
  rows: DuplicateBankInputRow[],
): DuplicateBankGroup[] {
  const buckets = new Map<string, DuplicateBankInputRow[]>();
  for (const row of rows) {
    const key = eventKey(row);
    const arr = buckets.get(key);
    if (arr) arr.push(row);
    else buckets.set(key, [row]);
  }

  const groups: DuplicateBankGroup[] = [];
  for (const members of buckets.values()) {
    // De-dup by distinct id (defensive — the same id should never appear twice,
    // but a join could theoretically fan out).
    const byId = new Map<string, DuplicateBankInputRow>();
    for (const m of members) if (!byId.has(m.id)) byId.set(m.id, m);
    const distinct = [...byId.values()];
    if (distinct.length < 2) continue; // not a duplicate

    // Canonical = oldest by first_seen_at; deterministic tie-break on id.
    let canonical = distinct[0];
    for (const m of distinct) {
      if (
        isOlder(m.firstSeenAt, canonical.firstSeenAt) ||
        (m.firstSeenAt === canonical.firstSeenAt && m.id < canonical.id)
      ) {
        canonical = m;
      }
    }

    const duplicateIds = distinct
      .filter((m) => m.id !== canonical.id)
      .map((m) => m.id);

    // Prefer the canonical row's link; fall back to any linked member.
    let linkedTransactionId: number | undefined =
      canonical.linkedTransactionId ?? undefined;
    if (linkedTransactionId == null) {
      const linked = distinct.find((m) => m.linkedTransactionId != null);
      if (linked) linkedTransactionId = linked.linkedTransactionId ?? undefined;
    }

    const seenCount = distinct.reduce((mx, m) => Math.max(mx, m.seenCount), 0);

    groups.push({
      canonicalId: canonical.id,
      duplicateIds,
      date: canonical.date,
      amount: canonical.amount,
      payee: canonical.payeePlain ?? "",
      seenCount,
      ...(linkedTransactionId != null ? { linkedTransactionId } : {}),
    });
  }

  // Stable, useful ordering: most-recent event first.
  groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return groups;
}
