/**
 * Audit the load-bearing invariants enforced application-layer (no DB CHECK
 * constraints) — FINLYNQ-48.
 *
 * Grep-walks every relevant write-site in the repo and verifies that the
 * required helper appears in the SAME file. Co-occurrence (not AST) is good
 * enough as a fast pre-commit / CI signal — the goal is to catch the "forgot
 * one" class of regression (issues #214, #211, #230, #205 cohort) before it
 * ships, not to prove soundness.
 *
 * Seven invariants today (see CLAUDE.md "Load-bearing gotchas"):
 *
 *   1. sign-vs-category          — every transactions INSERT must call
 *                                  `validateSignVsCategory` or use
 *                                  `createTransferPair*` (transfer-exempt by
 *                                  construction).
 *   2. decryptNameish-before-fuzzyFind
 *                                — any file that calls `fuzzyFind(name, rows)`
 *                                  must also call `decryptNameish` (the cohort
 *                                  that produced issues #214, #211, #230).
 *   3. invalidateUser-after-mcp-tx-mutation
 *                                — every MCP tool file with a transactions
 *                                  INSERT/UPDATE must also call
 *                                  `invalidateUserTxCache` / `invalidateUser`.
 *   4. holding_accounts-dual-write
 *                                — every file that INSERTs into
 *                                  `portfolio_holdings` must also INSERT into
 *                                  `holding_accounts` (issue #95 + #205, 9
 *                                  sites today).
 *   5. transactions-updated_at   — every UPDATE on `transactions` must set
 *                                  `updated_at = NOW()` (issue #28 audit
 *                                  trio).
 *   6. buildNameFields-on-stream-d-tables
 *                                — every INSERT/UPDATE on a Stream-D-encrypted
 *                                  table that writes a display name must
 *                                  compute it via `buildNameFields` /
 *                                  `encryptName`. We only check write-side
 *                                  occurrences (`.values({ ... nameCt ... })`
 *                                  or `SET name_ct = ...`) — schema defs,
 *                                  SELECT lists, comments, blog posts, etc.
 *                                  are excluded.
 *   7. lots-write-hook           — every transactions write-site that
 *                                  touches `portfolio_holding_id` must
 *                                  apply lot effects via
 *                                  `applyLotEffectsForTx` /
 *                                  `*LotHook` / `reverseLotsForDeleteHook`
 *                                  (plan/portfolio-lots-and-performance.md
 *                                  Phase 1).
 *   8. portfolio-ops-kind-via-operations
 *                                — any file that literally writes
 *                                  `kind: "buy"` / `kind: "sell"` /
 *                                  `kind: "buy_cash_leg"` /
 *                                  `kind: "sell_cash_leg"` /
 *                                  `kind: "fx_*"` /
 *                                  `kind: "in_kind_transfer_*"` must
 *                                  import the matching helper from
 *                                  `@/lib/portfolio/operations` — the
 *                                  only writer that knows how to pair
 *                                  legs correctly + invoke the lot
 *                                  engine + share the trade_link_id
 *                                  (portfolio ops Phase 1, 2026-05-25).
 *
 * Output:
 *   ALL INVARIANTS PASS                  (exit 0)
 *   FAIL: <invariant> <file>:<line> ...  (exit 1)
 *
 * Excludes: tests/, node_modules/, .next/, dist/, this script itself,
 * `*.test.ts`, doc files, and the schema definition file (which is a
 * declaration, not a write). Migrations (*.sql) are excluded — invariants are
 * application-layer; SQL files are out of scope.
 *
 * Known baseline exceptions: see BASELINE_EXCEPTIONS below.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "..");
const EXCLUDE_PREFIXES = [
  "tests/",
  "node_modules/",
  ".next/",
  "dist/",
  "scripts/audit-invariants.",
  "docs/",
  "src/app/blog/",
  "src/app/mcp-guide/",
  "src/db/schema-pg.ts",
];

/**
 * Per-callsite exceptions: callsites we explicitly accept as not matching the
 * invariant, with a documented reason.
 *
 * Keys are `<relative-path>:<invariant-id>`. The audit treats a match here as
 * a pass.
 */
const BASELINE_EXCEPTIONS: Record<string, string> = {
  // tools-import-templates.ts ALWAYS inserts with `category_id = NULL` (the
  // INSERT literal hard-codes `NULL` in the column position). Per the
  // validator, uncategorized rows are exempt from sign-vs-category. Adding a
  // validateSignVsCategory call here would be dead code.
  "mcp-server/tools-import-templates.ts:sign-vs-category":
    "INSERT hard-codes category_id = NULL — uncategorized rows are exempt by validator",
  // sample-data onboarding seeds hand-curated rows with signs that match
  // category type by construction (I=+, E=-). The bulk insert uses pre-built
  // tuples; running validateSignVsCategoryById N times against in-memory data
  // would be wasted I/O. Accepted as a baseline exception.
  "src/app/api/onboarding/sample-data/route.ts:sign-vs-category":
    "hand-curated fixtures with signs matching category type by construction",
  // register-core-tools.ts is the stdio MCP transport. Stream D Phase 4
  // refuses every write to the 6 encrypted tables (no DEK on stdio). The file
  // DEFINES its own SQLite-shape `fuzzyFind` for read-side cash-account
  // lookups; no read currently routes through name-encrypted columns on
  // stdio. Accepted.
  "mcp-server/register-core-tools.ts:decryptNameish-before-fuzzyFind":
    "stdio MCP refuses Stream-D writes; fuzzyFind here is read-side on plaintext cash-only paths",
  // tools-import-templates.ts inserts transactions with import_hash; the
  // module is loaded only inside the stdio MCP's import-template flow and
  // there is no per-user tx cache on stdio (the cache module is global in
  // register-core-tools.ts and invalidated by the broader MCP flow). Accepted
  // as a baseline exception; if we later wire a tx cache into stdio import
  // templates, remove this and add the call.
  "mcp-server/tools-import-templates.ts:invalidateUser-after-mcp-tx-mutation":
    "stdio import-template flow; tx cache is invalidated by the enclosing register-core-tools.ts handler",
  // WealthPosition balance-reconciliation insert (connector flow). The
  // category id is admin-mapped via importConnectorMappings, and the row
  // amount is a computed delta (can be either sign depending on direction).
  // Predates issue #212 (sign-vs-category at every callsite). Tracked as a
  // followup to wire validateSignVsCategoryById into the reconciliation
  // helper.
  "src/lib/external-import/reconciliation.ts:sign-vs-category":
    "predates issue #212; followup to wire validateSignVsCategoryById into the reconciliation helper",
  // FINLYNQ-97 — sign-vs-category check is advisory and lives at the route
  // boundary (`/api/transactions` POST/PUT) instead of the inner helper.
  // The validator still runs for every REST write, but the result becomes
  // a `warning` on the success body rather than a thrown error in the
  // helper. Calling the validator inside `createTransaction` would be a
  // redundant DB round-trip with no behavioral effect.
  "src/lib/queries.ts:sign-vs-category":
    "FINLYNQ-97 — validator moved to /api/transactions route boundary; advisory warning on success body",
  // Lot-tracking wiring TODOs (Phase 1, 2026-05-25). The big-three MCP HTTP
  // write tools below need lot hooks wired before portfolio_lots_status.enabled
  // can flip TRUE for any user. Tracked as Phase 1 follow-up; backfill catches
  // the gap in the meantime. Each baseline exception is a known wiring
  // task, NOT a permanent "doesn't need lots" carve-out. Remove the
  // exception line as each tool gets wired.
  //
  // bulk_record_transactions — needs per-row applyLotEffectsForTx loop after the batch INSERT.
  // record_trade — buy-pair tool, needs openLotForBuyHook on the stock leg + paired-cash-leg substitution.
  // update_transaction — needs reverseLotsForDeleteHook + redo via applyLotEffectsForTx.
  // (record_transaction + delete_transaction are already wired as of 2026-05-25.)
  "mcp-server/register-tools-pg.ts:lots-write-hook":
    "Phase 1 follow-up — bulk_record_transactions / record_trade / update_transaction need lot wiring; record_transaction + delete_transaction already wired; backfill covers the gap until flag-flip",
  // operations.ts is the canonical writer of the multi-leg portfolio op
  // kinds; it can't very well "import from @/lib/portfolio/operations" of
  // itself. Accepted as a baseline exception for invariant #8.
  "src/lib/portfolio/operations.ts:portfolio-ops-kind-via-operations":
    "operations.ts is the canonical writer; cannot self-import",
  // seed-demo.ts uses raw-SQL INSERTs to populate the demo's investment
  // history (legacy pattern — predates operations.ts). Each row's `kind`
  // is set by the qty-sign rule that matches the schema-migration backfill,
  // and the lots-backfill at the end of seed-demo (buildLotsForUser) wires
  // the cost-basis side. Phase 2 follow-up: route through operations.ts
  // so the seed itself produces paired cash-leg rows (today the demo's
  // cash sleeve qty is derived from the backfill, not literal rows).
  "scripts/seed-demo.ts:portfolio-ops-kind-via-operations":
    "Phase 2 follow-up — seed uses legacy raw-SQL with `kind` tagged by qty sign; lots-backfill at end wires cost basis",
  // The Phase 2 one-off backfill script INSERTs cash-leg rows for legacy
  // single-row buys/sells. It uses raw `pg.Pool` SQL (not Drizzle, not the
  // app helpers) so it can run against any environment without pulling the
  // PostgresAdapter bootstrap chain. The TypeScript `kind: "buy" | "sell"`
  // type annotation at line 130 is what trips the regex — there are no
  // actual `kind: "buy"` value writes; the script writes `kind: 'buy_cash_leg'`
  // / `'sell_cash_leg'` literals which are correctly paired with the source
  // rows. Accepted as a one-off-script exception (file is delete-after-use).
  "scripts/backfill-buy-sell-cash-legs.ts:portfolio-ops-kind-via-operations":
    "One-off raw-SQL backfill script; regex false-positive on a TypeScript union type annotation. Writes only `*_cash_leg` literals.",
  // The transaction-canonicalization backfill planner is a PURE module that
  // emits Proposal payloads — it doesn't write to the DB itself. The actual
  // INSERT/UPDATE of `kind` happens in src/lib/portfolio/backfill/apply.ts
  // which calls applyLotEffectsForTx from @/lib/portfolio/lots/write-hooks
  // (the canonical lot module). Putting an unused `import` of operations.ts
  // in the planner would be cargo-culted; the planner's correctness contract
  // is exercised by tests/backfill-planner.test.ts. Accepted as a pure-module
  // exception for invariant #8. → pf-app/docs/architecture/backfill.md.
  "src/lib/portfolio/backfill/planner.ts:portfolio-ops-kind-via-operations":
    "Pure planner module — emits Proposal payloads; the apply path materializes them via applyLotEffectsForTx from the canonical lot module.",
};

interface InvariantConfig {
  id: string;
  description: string;
  /** Paths to scan (relative; either dir-walk or specific file). */
  fileGlobs: string[];
  /**
   * Regex that identifies a write-site (or trigger condition). Matched per
   * line.
   */
  writeSite: RegExp;
  /**
   * Regex that, if present ANYWHERE in the same file, satisfies the
   * invariant. We use `multi-line .` (the regex is applied to the full file
   * contents).
   */
  requiredHelper: RegExp;
  /** Human-friendly name of the helper for the error message. */
  helperName: string;
}

const INVARIANTS: InvariantConfig[] = [
  {
    id: "sign-vs-category",
    description:
      "every transactions INSERT must call validateSignVsCategory / createTransferPair",
    fileGlobs: [
      "src/lib/queries.ts",
      "src/lib/transfer.ts",
      "src/lib/import-pipeline.ts",
      "src/lib/external-import/",
      "src/app/api/import/staged/",
      "src/app/api/transactions/",
      "src/app/api/onboarding/",
      "mcp-server/register-tools-pg.ts",
      "mcp-server/register-core-tools.ts",
      "mcp-server/tools-import-templates.ts",
    ],
    // Either a Drizzle insert into transactions or a raw `INSERT INTO transactions`.
    writeSite:
      /db\s*\.\s*insert\(\s*(?:schema\.)?transactions\s*\)|INSERT\s+INTO\s+transactions\b/,
    // Either the validator helper or a transfer-pair helper (exempt by
    // construction) — both names cover the policy.
    requiredHelper:
      /validateSignVsCategory|createTransferPair(?:ViaSql)?\b/,
    helperName: "validateSignVsCategory or createTransferPair",
  },
  {
    id: "decryptNameish-before-fuzzyFind",
    description:
      "any file that calls fuzzyFind(name, rows) must call decryptNameish on the row set first (issues #214/#211/#230 cohort)",
    fileGlobs: [
      "src/",
      "mcp-server/",
    ],
    // Only USE sites: `fuzzyFind(`. We exclude the function DEFINITION at
    // declaration sites via the BASELINE_EXCEPTIONS for register-core-tools.ts
    // (which defines its own fuzzyFind and uses it on plaintext stdio paths).
    writeSite: /\bfuzzyFind\s*\(/,
    requiredHelper: /\bdecryptNameish\s*\(/,
    helperName: "decryptNameish",
  },
  {
    id: "invalidateUser-after-mcp-tx-mutation",
    description:
      "every MCP tool file with a transactions INSERT/UPDATE must call invalidateUserTxCache (per-user tx cache staleness)",
    fileGlobs: [
      "mcp-server/register-tools-pg.ts",
      "mcp-server/register-core-tools.ts",
      "mcp-server/tools-import-templates.ts",
    ],
    writeSite:
      /(?:INSERT\s+INTO\s+transactions|UPDATE\s+transactions|db\s*\.\s*(?:insert|update)\(\s*(?:schema\.)?transactions\s*\))/,
    requiredHelper: /invalidateUser(?:TxCache)?\s*\(/,
    helperName: "invalidateUserTxCache",
  },
  {
    id: "holding_accounts-dual-write",
    description:
      "every portfolio_holdings INSERT must dual-write a holding_accounts pairing row (issue #95 + #205)",
    fileGlobs: [
      "src/",
      "mcp-server/",
      "packages/import-connectors/",
      "scripts/seed-demo.ts",
    ],
    writeSite:
      /db\s*\.\s*insert\(\s*(?:schema\.)?portfolioHoldings\s*\)|INSERT\s+INTO\s+portfolio_holdings\b/,
    requiredHelper:
      /INSERT\s+INTO\s+holding_accounts\b|db\s*\.\s*insert\(\s*(?:schema\.)?holdingAccounts\s*\)/,
    helperName: "INSERT INTO holding_accounts (dual-write)",
  },
  {
    id: "transactions-updated_at",
    description:
      "every UPDATE on transactions must set updated_at = NOW() (issue #28 audit trio)",
    fileGlobs: [
      "src/",
      "mcp-server/",
      "scripts/",
    ],
    writeSite:
      /(?:UPDATE\s+transactions\b|db\s*\.\s*update\(\s*(?:schema\.)?transactions\s*\))/,
    // We accept either the SQL form, the Drizzle `updatedAt: sql\`NOW()\``
    // form, or the `updates.push("updated_at = NOW()")` dynamic-builder form.
    requiredHelper:
      /updated_at\s*=\s*NOW\(\)|updatedAt\s*:\s*sql`NOW\(\)`|updatedAt\s*:\s*sql\.raw\(['"`]NOW\(\)['"`]\)|updates\.push\(\s*["'`]updated_at\s*=\s*NOW\(\)/,
    helperName: "updated_at = NOW() (Drizzle: updatedAt: sql`NOW()`)",
  },
  {
    id: "lots-write-hook",
    description:
      "every write-site touching transactions.portfolio_holding_id must apply lot effects (plan/portfolio-lots-and-performance.md Phase 1)",
    // Narrow file globs — only the canonical writer surfaces. Other paths
    // route through these (e.g. /api/import/staged/[id]/approve calls into
    // executeImport + createTransferPair, both already wired).
    fileGlobs: [
      "src/app/api/transactions/route.ts",
      "src/lib/transfer.ts",
      "src/lib/import-pipeline.ts",
      "mcp-server/register-tools-pg.ts",
    ],
    // Trigger fires only on writes that ACTUALLY touch portfolio_holding_id
    // (raw SQL column reference) or portfolioHoldingId (Drizzle camelCase).
    // A bare `db.delete(transactions)` doesn't flip the lot state on its
    // own; the matching write-side INSERT/UPDATE flagged for the same file
    // gets the hook.
    writeSite:
      /(?:INSERT\s+INTO\s+transactions[\s\S]{0,2000}?portfolio_holding_id|UPDATE\s+transactions\b[\s\S]{0,1000}?portfolio_holding_id|portfolioHoldingId\s*:)/i,
    // Any of the lot hooks (or the dispatcher) satisfies the invariant.
    requiredHelper:
      /\b(?:applyLotEffectsForTx|openLotForBuyHook|closeLotsForSellHook|transferLotHook|reverseLotsForDeleteHook|openLotForBuy|closeLotsForSell|transferLot)\b/,
    helperName: "applyLotEffectsForTx / *LotHook (Phase 1 lot tracking)",
  },
  {
    id: "portfolio-ops-kind-via-operations",
    description:
      "any file that writes one of the portfolio-op kind discriminators (buy/sell/buy_cash_leg/sell_cash_leg/fx_*/in_kind_transfer_*) must import the matching helper from @/lib/portfolio/operations — otherwise the cash-leg pairing + lot wiring is incomplete (portfolio ops Phase 1, 2026-05-25)",
    fileGlobs: [
      "src/",
      "mcp-server/",
      "scripts/",
    ],
    // Trigger on a literal `kind: "<op>"` or `kind: '<op>'` for any
    // operation kind that requires multi-row pairing. portfolio_income /
    // portfolio_expense are intentionally NOT in this list — they're
    // single-row writes and can be written directly without the helper.
    writeSite:
      /kind\s*:\s*['"](?:buy|sell|buy_cash_leg|sell_cash_leg|fx_from|fx_to|fx_fee|in_kind_transfer_in|in_kind_transfer_out|brokerage_deposit_in|brokerage_deposit_out|brokerage_withdrawal_in|brokerage_withdrawal_out)['"]/,
    // Any import from the operations module satisfies the invariant.
    // operations.ts itself is the canonical writer; its own writes don't
    // need to import it (and won't match this import regex), so we add a
    // baseline exception for operations.ts below.
    requiredHelper:
      /from\s+["']@\/lib\/portfolio\/operations["']|from\s+["']\.{1,2}\/(?:[^"']*\/)?operations["']/,
    helperName: "import from @/lib/portfolio/operations",
  },
  {
    id: "buildNameFields-on-stream-d-tables",
    description:
      "every WRITE to a Stream D table's name_ct/name_lookup must compute via buildNameFields / encryptName",
    fileGlobs: [
      "src/",
      "mcp-server/",
      "packages/import-connectors/",
      "scripts/seed-demo.ts",
    ],
    // Real write-sites only:
    //   - Drizzle: `.values({ ... })` where the spread includes a name_ct;
    //     here we detect a literal `nameCt:` appearing inside an object
    //     literal that's a value-position (heuristic: `nameCt:` preceded by
    //     `{` on the same or adjacent line and inside a `.values(` call). To
    //     stay grep-only, we instead look for `name_ct` in a SQL `INSERT INTO
    //     <stream-d-table>` or `SET name_ct = ` UPDATE clause.
    // We DO NOT match schema definitions (`text("name_ct")` → schema-pg.ts is
    // excluded), nor SELECT clauses (`nameCt: schema.<table>.nameCt`), nor
    // doc / blog mentions.
    writeSite:
      /INSERT\s+INTO\s+(?:accounts|categories|goals|loans|subscriptions|portfolio_holdings)\b[\s\S]{0,1000}?name_ct\b|SET\s+name_ct\s*=|SET\s+name_lookup\s*=/i,
    requiredHelper: /\b(?:buildNameFields|encryptName)\s*\(/,
    helperName: "buildNameFields or encryptName",
  },
];

// ---------------------------------------------------------------------------

interface Hit {
  file: string;
  line: number;
  preview: string;
}

interface Failure {
  invariantId: string;
  helperName: string;
  hit: Hit;
}

function isExcluded(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/");
  return (
    EXCLUDE_PREFIXES.some((p) => norm === p || norm.startsWith(p)) ||
    /\.test\.[mc]?[jt]sx?$/.test(norm) ||
    norm.endsWith(".d.ts") ||
    norm.endsWith(".sql")
  );
}

function walkDir(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(REPO, full).replace(/\\/g, "/");
    if (isExcluded(rel)) continue;
    if (e.isDirectory()) {
      walkDir(full, out);
    } else if (e.isFile()) {
      if (/\.(ts|tsx|mjs|js|cjs)$/.test(e.name)) {
        out.push(full);
      }
    }
  }
}

function listCandidateFiles(globs: string[]): string[] {
  const out = new Set<string>();
  for (const g of globs) {
    const abs = path.join(REPO, g);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const collected: string[] = [];
      walkDir(abs, collected);
      for (const f of collected) out.add(f);
    } else if (stat.isFile()) {
      const rel = path.relative(REPO, abs).replace(/\\/g, "/");
      if (!isExcluded(rel)) out.add(abs);
    }
  }
  return [...out];
}

/** Find write-site hits within file lines. For multi-line patterns we run the
 *  regex over the full file text and locate each match's line number. */
function findHits(file: string, re: RegExp): Hit[] {
  let src: string;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rel = path.relative(REPO, file).replace(/\\/g, "/");
  const hits: Hit[] = [];
  // Run as global to find all matches; if the regex isn't global, fall back
  // to per-line scan.
  const globalRe = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : re.flags + "g",
  );
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(src)) !== null) {
    const idx = m.index;
    const before = src.slice(0, idx);
    const line = before.split(/\r?\n/).length;
    // Preview: the line containing the match start.
    const lines = src.split(/\r?\n/);
    hits.push({
      file: rel,
      line,
      preview: (lines[line - 1] ?? "").trim().slice(0, 140),
    });
    // Guard against zero-width loops.
    if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
  }
  return hits;
}

function fileHasHelper(file: string, re: RegExp): boolean {
  let src: string;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return re.test(src);
}

function checkInvariant(inv: InvariantConfig): {
  ok: boolean;
  passed: number;
  failures: Failure[];
} {
  const files = listCandidateFiles(inv.fileGlobs);
  let passed = 0;
  const failures: Failure[] = [];
  for (const f of files) {
    const hits = findHits(f, inv.writeSite);
    if (hits.length === 0) continue;
    const helperPresent = fileHasHelper(f, inv.requiredHelper);
    if (helperPresent) {
      passed += hits.length;
      continue;
    }
    const rel = path.relative(REPO, f).replace(/\\/g, "/");
    const exceptionKey = `${rel}:${inv.id}`;
    if (BASELINE_EXCEPTIONS[exceptionKey]) {
      passed += hits.length;
      continue;
    }
    for (const h of hits) {
      failures.push({ invariantId: inv.id, helperName: inv.helperName, hit: h });
    }
  }
  return { ok: failures.length === 0, passed, failures };
}

function main(): number {
  let anyFail = false;
  console.log("Auditing load-bearing invariants under", REPO);
  console.log("");
  for (const inv of INVARIANTS) {
    const { ok, passed, failures } = checkInvariant(inv);
    if (ok) {
      console.log(`[PASS] ${inv.id}: ${passed} callsite(s) OK`);
    } else {
      anyFail = true;
      console.log(
        `[FAIL] ${inv.id}: ${failures.length} callsite(s) missing helper "${inv.helperName}" (${passed} OK)`,
      );
      for (const f of failures) {
        console.log(
          `       FAIL: ${f.hit.file}:${f.hit.line} ${inv.id} missing helper ${inv.helperName}`,
        );
        console.log(`         > ${f.hit.preview}`);
      }
    }
  }
  console.log("");
  if (anyFail) {
    console.log(
      "AUDIT FAILED — at least one load-bearing invariant has a write-site without the matching helper.",
    );
    return 1;
  }
  console.log("ALL INVARIANTS PASS");
  return 0;
}

const exitCode = main();
process.exit(exitCode);
