"use client";

/**
 * Unresolved-category banner for /import/pending (FINLYNQ-57, FINLYNQ-90).
 *
 * Rendered above the row table when the approve endpoint returned 400 with
 * `code: 'unresolved_categories'`. Lists the N affected rows by payee and
 * exposes three options per row (well — two inline; the third is the
 * existing per-row editor below the banner):
 *
 *   1. Assign category to this row only → uses the existing PATCH endpoint
 *      at /api/import/staged/[id]/rows/[rowId] (NOT re-implemented here).
 *      The user just expands the row in the table below and uses the
 *      StagedRowEditor; this banner stays out of the way for that path.
 *   2. Create a rule + apply to current batch → POST
 *      /api/import/staged/[id]/create-rule. FINLYNQ-90 swapped the inline
 *      legacy 3-field form for the shared `RuleEditorDialog`; the user
 *      now gets the full v2 surface (multi-condition AND group, 7 action
 *      kinds, priority + isActive, live preview) seeded from the row's
 *      payee. Historical `transactions` are untouched (scoped per the
 *      item spec).
 *   3. Cancel → dismiss the banner; user is free to manually assign or
 *      re-approve. The unresolved set will reappear on the next approve
 *      attempt if any row still lacks a category.
 *
 * After a rule applies, the parent re-fetches the staged detail and the
 * banner's row list shrinks via the parent's `setUnresolved` filter. The
 * `onRuleApplied` callback is the trigger.
 *
 * Lazy-fetch — the 3 FK option lists (categories / accounts / holdings)
 * are NOT fetched on banner mount. They're fetched on the FIRST per-row
 * "Create rule" click and cached in component state; subsequent clicks
 * reuse the cache. Dismissing the banner without ever clicking "Create
 * rule" triggers ZERO fetches. Load-bearing for the banner-only-on-error
 * traffic shape.
 */

import { useState } from "react";
import { AlertTriangle, X, PlusCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  RuleEditorDialog,
  type Category,
  type Account,
  type Holding,
} from "@/components/rules/rule-editor-dialog";
import type { Condition } from "@/lib/rules/schema";

export interface UnresolvedRow {
  id: string;
  payee: string;
}

interface FkCache {
  categories?: Category[];
  accounts?: Account[];
  holdings?: Holding[];
}

interface Props {
  stagedImportId: string;
  rowIds: string[];
  payees: string[];
  /** Called after a rule POST succeeds; parent re-fetches detail + recomputes set. */
  onRuleApplied: () => void;
  /** User-dismissed the banner without resolving. Parent clears state. */
  onDismiss: () => void;
}

export function UnresolvedCategoriesBanner({
  stagedImportId,
  rowIds,
  payees,
  onRuleApplied,
  onDismiss,
}: Props) {
  // Which row's dialog is open (null = none). One dialog open at a time.
  const [dialogRowId, setDialogRowId] = useState<string | null>(null);
  // Per-banner-instance lazy cache for the 3 FK option lists.
  const [cache, setCache] = useState<FkCache>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch categories / accounts / holdings on FIRST dialog open. Re-opening
  // a second row reuses the cache. Dismissing the banner without clicking
  // any "Create rule" triggers zero fetches.
  const openDialogForRow = async (rowId: string) => {
    setLoadError(null);
    if (cache.categories && cache.accounts && cache.holdings) {
      setDialogRowId(rowId);
      return;
    }
    setLoading(true);
    try {
      const [catsRes, acctsRes, holdRes] = await Promise.all([
        fetch("/api/categories"),
        fetch("/api/accounts"),
        fetch("/api/portfolio"),
      ]);
      if (!catsRes.ok || !acctsRes.ok || !holdRes.ok) {
        setLoadError("Failed to load category / account / holding lists.");
        return;
      }
      const catsRaw = (await catsRes.json()) as Array<{
        id?: number;
        name?: string;
        type?: string;
        group?: string;
      }>;
      const acctsRaw = (await acctsRes.json()) as Array<{ id?: number; name?: string | null }>;
      const holdRaw = (await holdRes.json()) as Array<{ id?: number; name?: string | null }>;
      const categories: Category[] = catsRaw
        .filter((c) => c.id != null && c.name)
        .map((c) => ({
          id: c.id as number,
          name: c.name as string,
          type: c.type ?? "",
          group: c.group ?? "",
        }));
      const accounts: Account[] = acctsRaw
        .filter((a) => a.id != null && a.name)
        .map((a) => ({ id: a.id as number, name: a.name as string }));
      const holdings: Holding[] = holdRaw
        .filter((h) => h.id != null && h.name)
        .map((h) => ({ id: h.id as number, name: h.name as string }));
      setCache({ categories, accounts, holdings });
      setDialogRowId(rowId);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  if (rowIds.length === 0) return null;

  // Figure out the row payee to seed the dialog with.
  const dialogRow = dialogRowId
    ? (() => {
        const idx = rowIds.indexOf(dialogRowId);
        if (idx < 0) return null;
        return { id: dialogRowId, payee: payees[idx] ?? "" };
      })()
    : null;

  // Seed the rule name from the row's payee, truncated for the 120-char
  // `transaction_rules.name` length cap. `Match "<payee>"` adds 9 chars of
  // surround, so cap the payee slice at 100 to stay well inside.
  const initialName = dialogRow
    ? `Match "${(dialogRow.payee || "").trim().slice(0, 100)}"`
    : "";
  const initialConditions: Condition[] = dialogRow
    ? [{ field: "payee", op: "contains", value: (dialogRow.payee || "").trim() }]
    : [];

  return (
    <Card className="border-amber-300 bg-amber-50/40 dark:bg-amber-950/20">
      <CardContent className="py-3 space-y-2">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              {rowIds.length} row{rowIds.length === 1 ? "" : "s"} need a category before import
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
              Assign a category to each row (expand the row below) or create a rule that covers a payee pattern. Transfers don&apos;t need one.
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
              If you added a transfer or account rule recently, click <strong>Re-apply rules</strong> at the top of the page.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss banner"
            className="text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200 p-1 -m-1 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loadError && (
          <p className="ml-6 text-[11px] text-rose-700">{loadError}</p>
        )}

        <ul className="space-y-1.5 ml-6">
          {rowIds.map((rid, idx) => {
            const payee = payees[idx] ?? "(no payee)";
            return (
              <li key={rid} className="text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-amber-900 dark:text-amber-200 break-all">
                    {payee || <span className="italic text-muted-foreground">(empty payee)</span>}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[11px] border-amber-300 hover:bg-amber-100"
                    onClick={() => openDialogForRow(rid)}
                    disabled={loading}
                  >
                    <PlusCircle className="h-3 w-3 mr-1" />
                    {loading && dialogRowId === null ? "Loading…" : "Create rule"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>

      {dialogRow && cache.categories && cache.accounts && cache.holdings && (
        <RuleEditorDialog
          initialName={initialName}
          initialConditions={initialConditions}
          initialActions={[]}
          categories={cache.categories}
          accounts={cache.accounts}
          holdings={cache.holdings}
          submitLabel="Create rule + apply"
          title="Create rule from row"
          onClose={(saved) => {
            setDialogRowId(null);
            if (saved) onRuleApplied();
          }}
          onSubmit={async (payload) => {
            try {
              const res = await fetch(`/api/import/staged/${stagedImportId}/create-rule`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                return { ok: false, error: data?.error ?? "Rule creation failed" };
              }
              return { ok: true };
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : "Rule creation failed" };
            }
          }}
        />
      )}
    </Card>
  );
}
