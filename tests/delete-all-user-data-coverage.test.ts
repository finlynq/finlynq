/**
 * Static coverage gate for `deleteAllUserDataTx` (src/lib/auth/queries.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * CLAUDE.md has long stated the invariant "add a new per-user table to
 * `deleteAllUserDataTx` + both delete paths", but nothing enforced it, so the
 * function silently drifted behind the schema. Verified on pf_dev 2026-07-27:
 * after a successful `POST /api/auth/delete-account` (users row gone), a scan
 * of every `public` table with a `user_id` column still found rows for the
 * deleted user — including `securities`, which carries that user's
 * DEK-encrypted `symbol_ct` / `name_ct` / `symbol_lookup` / `name_lookup`.
 * Encrypted security identities survived an account deletion.
 *
 * This test is the drift alarm. It is PURE — it parses `schema-pg.ts` and
 * `queries.ts` as text; no database, no mocks, no app bootstrap. It cannot
 * prove the runtime outcome (that's `scripts/scan-user-residue.sql`, run
 * against a real DB), but it does catch the failure mode that actually bit us:
 * a new per-user table added to the schema and never wired into the wipe.
 *
 * WHAT COUNTS AS COVERAGE
 * -----------------------
 *  1. An explicit `tx.delete(s.<table>)` inside `deleteAllUserDataTx`.
 *  2. A NOT NULL `ON DELETE CASCADE` FK to a table that is itself covered.
 *
 * What deliberately does NOT count:
 *  - An FK to `users`. Only `deleteUserAccount` drops the user row;
 *    `wipeUserDataAndRewrap` KEEPS it, so those rows survive a wipe entirely.
 *    This is why `webhooks` / `backfill_runs` / `backfill_proposals` are now
 *    deleted explicitly even though they cascade.
 *  - A NULLABLE cascade FK. `portfolio_snapshots.account_id` cascades from
 *    accounts but is nullable, and `account_id IS NULL` is precisely the
 *    whole-portfolio aggregate bar — those rows escaped both paths.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const SCHEMA_SRC = readFileSync(path.join(ROOT, "src/db/schema-pg.ts"), "utf8");
const QUERIES_SRC = readFileSync(path.join(ROOT, "src/lib/auth/queries.ts"), "utf8");

/**
 * Per-user tables that are intentionally NOT deleted. Each entry needs a
 * reason — this list is the escape hatch, so it must never grow silently.
 */
const EXEMPT: Record<string, string> = {
  feedback:
    "FINLYNQ-226/228 — maintainer-owned support records. Deliberately survive " +
    "wipe/delete (the maintainer keeps the bug report). The privacy-sensitive " +
    "attachment pointers ARE nulled in deleteAllUserDataTx and the on-disk " +
    "files unlinked by unlinkUserUploadFiles.",
};

type Column = {
  column: string; // TS property name, e.g. accountId
  sqlName: string | null; // SQL column name, e.g. account_id
  notNull: boolean;
  refTable: string | null; // schema VARIABLE name of the referenced table
  onDelete: string | null;
};

type Table = {
  variable: string; // e.g. portfolioHoldings
  table: string; // e.g. portfolio_holdings
  columns: Column[];
};

/** Parse every `export const X = pgTable("y", {...})` block out of schema-pg.ts. */
function parseSchema(src: string): Table[] {
  const header = /export const (\w+) = pgTable\(\s*\n?\s*"([\w_]+)"/g;
  const marks: { variable: string; table: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = header.exec(src)) !== null) {
    marks.push({ variable: m[1], table: m[2], index: m.index });
  }

  return marks.map((mark, i) => {
    const body = src.slice(mark.index, i + 1 < marks.length ? marks[i + 1].index : src.length);

    // Column declarations sit at 2 spaces of indent in the `pgTable("x", {…})`
    // form and 4 in the multi-line `pgTable(\n "x",\n {…},\n (t) => […])` form.
    //
    // The trailing `\w+\(` is load-bearing: a column is always `name: text(…)` /
    // `integer(…)` / …, whereas an option key is `onDelete: "set null"` with no
    // call. Without it, a multi-line `.references(() => x.id, {\n onDelete: … })`
    // put `onDelete` at exactly 4 spaces, so it parsed as its OWN column and
    // truncated the real column's span before its options — every such FK then
    // read as NO ACTION. That made the ordering check below report
    // `email_inbox.staged_import_id` and `email_import_rules.category_id` as
    // violations when both are ON DELETE SET NULL in the database.
    const declRe = /\n {2,4}(\w+): \w+\(/g;
    const decls: { column: string; index: number }[] = [];
    let d: RegExpExecArray | null;
    while ((d = declRe.exec(body)) !== null) {
      decls.push({ column: d[1], index: d.index });
    }

    const columns: Column[] = decls.map((decl, j) => {
      const span = body.slice(
        decl.index,
        j + 1 < decls.length ? decls[j + 1].index : body.length,
      );
      // `.references(() => accounts.id, { onDelete: "cascade" })`, also
      // tolerating the self-referential `(): any =>` form (holding_lots).
      // The `,?` before the closing brace is load-bearing: the multi-line form
      //     .references(() => stagedImports.id, {
      //       onDelete: "set null",
      //     })
      // carries a TRAILING COMMA, so `"…"\s*\}` never matched and the FK read
      // as NO ACTION. That made the ordering check below report
      // `email_inbox.staged_import_id` and `email_import_rules.category_id` as
      // violations when both are ON DELETE SET NULL in the database.
      const ref = span.match(
        /\.references\(\s*\(\)(?:\s*:\s*any)?\s*=>\s*(\w+)\.\w+\s*(?:,\s*\{\s*onDelete:\s*"([\w ]+)"\s*,?\s*\})?/,
      );
      return {
        column: decl.column,
        sqlName: span.match(/^\s*\w+:\s*\w+\("([\w_]+)"\)/)?.[1] ?? null,
        notNull: /\.notNull\(\)/.test(span),
        refTable: ref ? ref[1] : null,
        onDelete: ref?.[2] ?? null,
      };
    });

    return { variable: mark.variable, table: mark.table, columns };
  });
}

/** Extract the body of `deleteAllUserDataTx` by brace-matching from its signature. */
function deleteFnBody(src: string): string {
  const sigIndex = src.indexOf("async function deleteAllUserDataTx(");
  expect(sigIndex, "deleteAllUserDataTx not found in queries.ts").toBeGreaterThan(-1);
  const open = src.indexOf("{", sigIndex);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces in deleteAllUserDataTx");
}

const TABLES = parseSchema(SCHEMA_SRC);
const BODY = deleteFnBody(QUERIES_SRC);

/** Schema variables passed to `tx.delete(s.X)` inside the shared body. */
const EXPLICIT = new Set<string>(
  [...BODY.matchAll(/tx\s*\n?\s*\.delete\(s\.(\w+)\)/g)].map((m) => m[1]),
);

/** Tables carrying a `user_id` column — i.e. the per-user surface. */
const USER_TABLES = TABLES.filter((t) => t.columns.some((c) => c.sqlName === "user_id"));

/**
 * Fixpoint: a table is covered if it is deleted explicitly, or cascades to a
 * covered table over a NOT NULL FK.
 */
function computeCovered(): Map<string, string> {
  const covered = new Map<string, string>();
  for (const v of EXPLICIT) covered.set(v, "explicit tx.delete()");

  let changed = true;
  while (changed) {
    changed = false;
    for (const t of TABLES) {
      if (covered.has(t.variable)) continue;
      for (const c of t.columns) {
        if (!c.refTable || c.onDelete !== "cascade" || !c.notNull) continue;
        if (c.refTable === "users") continue; // wipe keeps the user row
        if (!covered.has(c.refTable)) continue;
        covered.set(t.variable, `NOT NULL cascade via ${c.column} -> ${c.refTable}`);
        changed = true;
        break;
      }
    }
  }
  return covered;
}

const COVERED = computeCovered();

describe("deleteAllUserDataTx table coverage", () => {
  it("parses the schema and the delete body", () => {
    // Sanity floors: if the parser silently stops matching, every other
    // assertion here passes vacuously.
    expect(TABLES.length).toBeGreaterThan(60);
    expect(USER_TABLES.length).toBeGreaterThan(45);
    expect(EXPLICIT.size).toBeGreaterThan(30);
    // Spot-check the parse of a known cascade edge.
    const holdingLots = TABLES.find((t) => t.table === "holding_lots")!;
    const holdingId = holdingLots.columns.find((c) => c.column === "holdingId")!;
    expect(holdingId).toMatchObject({
      notNull: true,
      refTable: "portfolioHoldings",
      onDelete: "cascade",
    });
  });

  it("deletes or cascades every per-user table", () => {
    const uncovered = USER_TABLES.filter(
      (t) => !COVERED.has(t.variable) && !(t.table in EXEMPT),
    ).map((t) => t.table);

    expect(
      uncovered,
      `These tables carry user_id but survive a wipe/delete. Add a ` +
        `tx.delete(s.<table>) to deleteAllUserDataTx, or document an ` +
        `exemption in EXEMPT here:\n  ${uncovered.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the regression tables explicitly covered", () => {
    // The two empirically-confirmed residue tables (pf_dev 2026-07-27) plus the
    // siblings that were uncovered for the same reason. Cascade coverage is NOT
    // acceptable for these — assert an explicit delete so a future FK change
    // can't quietly re-open the hole.
    for (const v of [
      "securities",
      "portfolioCashSnapshotMeta",
      "portfolioSnapshots",
      "portfolioSnapshotDirty",
      "portfolioCashSnapshotDirty",
      "portfolioLotsStatus",
      "portfolioLegacyRealizedGainSnapshot",
      "reportingRecomputeStatus",
      "announcementReads",
      "mcpIdempotencyKeys",
      "webhooks",
      "backfillRuns",
      "backfillProposals",
    ]) {
      expect(EXPLICIT.has(v), `${v} must be deleted explicitly`).toBe(true);
    }
  });

  it("deletes children before parents across every NO ACTION FK", () => {
    // Presence is not enough — ORDER is load-bearing, and only for NO ACTION.
    // Confirmed on pf_dev 2026-07-27: `staged_imports` and `staged_transactions`
    // were both deleted (so the coverage test above passed) but ~80 lines AFTER
    // `accounts`, which they reference NO ACTION via `bound_account_id` /
    // `target_account_id`. The `accounts` DELETE raised 23503 and aborted the
    // whole transaction, so any user who had ever uploaded a statement bound to
    // an account could not delete their account or wipe their data at all.
    //
    // CASCADE and SET NULL impose no ordering (Postgres fixes the child up
    // itself), so only an FK with no `onDelete` is checked here.
    const deleteIndex = (variable: string) =>
      BODY.search(new RegExp(`tx\\s*\\n?\\s*\\.delete\\(s\\.${variable}\\)`));

    let edgesChecked = 0;
    const violations: string[] = [];
    for (const t of TABLES) {
      if (!EXPLICIT.has(t.variable)) continue;
      for (const c of t.columns) {
        if (!c.refTable || c.onDelete) continue; // cascade/set null: order-free
        if (c.refTable === t.variable) continue; // self-reference
        if (!EXPLICIT.has(c.refTable)) continue; // parent not deleted here
        const child = deleteIndex(t.variable);
        const parent = deleteIndex(c.refTable);
        if (child < 0 || parent < 0) continue;
        edgesChecked++;
        if (child > parent) {
          const parentTable =
            TABLES.find((x) => x.variable === c.refTable)?.table ?? c.refTable;
          violations.push(
            `${t.table}.${c.sqlName ?? c.column} -> ${parentTable} ` +
              `(child deleted AFTER parent — will raise 23503)`,
          );
        }
      }
    }

    // Floor: if the parse silently stops matching, the assertion below passes
    // vacuously and the alarm is dead.
    expect(edgesChecked).toBeGreaterThan(8);
    expect(
      violations,
      `NO ACTION FK children must be deleted BEFORE their parent in ` +
        `deleteAllUserDataTx:\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("deletes securities after portfolio_holdings", () => {
    // portfolio_holdings.security_id is ON DELETE SET NULL, so the reverse
    // order would rewrite rows we are about to drop.
    expect(BODY.indexOf("s.securities")).toBeGreaterThan(BODY.indexOf("s.portfolioHoldings"));
  });

  it("sends a cleared account back through onboarding", () => {
    // Both surviving-account paths (wipe, DELETE /api/data) drop `settings` —
    // display_currency included — so without this the user lands on an empty
    // dashboard with no route back to the setup flow. It also keeps the
    // FINLYNQ-301 gate coherent: prompts stay silent while onboarding is
    // incomplete, so a cleared user is asked by the wizard, like a new signup.
    expect(BODY).toMatch(/onboardingComplete:\s*0/);
  });

  it("routes ALL THREE delete paths through the shared body", () => {
    // The paths must never drift on which tables they cover, so none may carry
    // a delete of its own. `DELETE /api/data` did exactly that until
    // 2026-07-27: 15 hand-rolled `db.delete()` calls, no transaction, and no
    // staged_imports/staged_transactions delete despite deleting `accounts`.
    // It was invisible to every assertion here because it lives in another
    // file — hence this explicit third check.
    const wipe = QUERIES_SRC.slice(QUERIES_SRC.indexOf("export async function wipeUserDataAndRewrap"));
    const del = QUERIES_SRC.slice(QUERIES_SRC.indexOf("export async function deleteUserAccount"));
    const clear = QUERIES_SRC.slice(QUERIES_SRC.indexOf("export async function clearAllUserData"));
    expect(wipe).toContain("deleteAllUserDataTx(tx, userId)");
    expect(del).toContain("deleteAllUserDataTx(tx, userId)");
    expect(clear).toContain("deleteAllUserDataTx(tx, userId)");

    const dataRoute = readFileSync(
      path.join(ROOT, "src/app/api/data/route.ts"),
      "utf8",
    );
    expect(dataRoute).toContain("clearAllUserData");
    // Strip comments first — the route's own header explains the deletes it no
    // longer performs, and prose must not read as code.
    const routeCode = dataRoute
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const routeDeletes = [...routeCode.matchAll(/\bdb\s*\n?\s*\.delete\(/g)];
    expect(
      routeDeletes.length,
      "DELETE /api/data must delegate to clearAllUserData, never delete rows itself",
    ).toBe(0);
    // deleteUserAccount may only delete the identity row itself.
    const strayDeletes = [...del.matchAll(/tx\.delete\(s\.(\w+)\)/g)]
      .map((m) => m[1])
      .filter((v) => v !== "users");
    expect(
      strayDeletes,
      "per-user deletes belong in deleteAllUserDataTx so WIPE picks them up too",
    ).toEqual([]);
  });
});
