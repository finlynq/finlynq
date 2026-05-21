"use client";

/**
 * Unresolved-category banner for /import/pending (FINLYNQ-57).
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
 *      /api/import/staged/[id]/create-rule. Inserts `transaction_rules`
 *      AND walks the staged batch to update matching rows. Historical
 *      `transactions` are untouched (scoped per the item spec).
 *   3. Cancel → dismiss the banner; user is free to manually assign or
 *      re-approve. The unresolved set will reappear on the next approve
 *      attempt if any row still lacks a category.
 *
 * After a rule applies, the parent re-fetches the staged detail and the
 * banner's row list shrinks via the parent's `setUnresolved` filter. The
 * `onRuleApplied` callback is the trigger.
 *
 * Design-system primitives only — no new shadcn components.
 */

import { useState } from "react";
import { AlertTriangle, X, PlusCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface UnresolvedRow {
  id: string;
  payee: string;
}

interface CategoryOption {
  id: number;
  name: string;
  type: string;
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
  // Open form per-row by id. Only one form open at a time keeps the layout
  // tight — the user clicks "Create rule" on the row they want.
  const [openFormForRowId, setOpenFormForRowId] = useState<string | null>(null);
  const [matchValue, setMatchValue] = useState("");
  const [matchType, setMatchType] = useState<"contains" | "exact" | "regex">("contains");
  const [categoryId, setCategoryId] = useState<string>("");
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Lazy-load categories on first form open. Avoids the fetch when the user
  // dismisses the banner without engaging.
  const ensureCategoriesLoaded = async () => {
    if (categories.length > 0) return;
    try {
      const res = await fetch("/api/categories");
      const data = await res.json();
      if (Array.isArray(data)) {
        setCategories(
          data
            .filter((c: { id?: number; name?: string }) => c.id != null && c.name)
            .map((c: { id: number; name: string; type: string }) => ({
              id: c.id,
              name: c.name,
              type: c.type,
            })),
        );
      }
    } catch {
      // Best-effort; the Select stays empty and the user can dismiss.
    }
  };

  const openForm = (rowId: string, defaultPayee: string) => {
    setOpenFormForRowId(rowId);
    setMatchValue(defaultPayee);
    setMatchType("contains");
    setCategoryId("");
    setFormError(null);
    void ensureCategoriesLoaded();
  };

  const cancelForm = () => {
    setOpenFormForRowId(null);
    setMatchValue("");
    setCategoryId("");
    setFormError(null);
  };

  const submitRule = async () => {
    if (!matchValue.trim() || !categoryId) {
      setFormError("Match pattern and category are required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/import/staged/${stagedImportId}/create-rule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchField: "payee",
          matchType,
          matchValue: matchValue.trim(),
          assignCategoryId: Number(categoryId),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data?.error ?? "Rule creation failed");
        return;
      }
      // Tell the parent to refresh staged detail and recompute the
      // unresolved set. The banner row count will drop on next render.
      cancelForm();
      onRuleApplied();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Rule creation failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (rowIds.length === 0) return null;

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

        <ul className="space-y-1.5 ml-6">
          {rowIds.map((rid, idx) => {
            const payee = payees[idx] ?? "(no payee)";
            const isOpen = openFormForRowId === rid;
            return (
              <li key={rid} className="text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-amber-900 dark:text-amber-200 break-all">
                    {payee || <span className="italic text-muted-foreground">(empty payee)</span>}
                  </span>
                  {!isOpen && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[11px] border-amber-300 hover:bg-amber-100"
                      onClick={() => openForm(rid, payee)}
                    >
                      <PlusCircle className="h-3 w-3 mr-1" />
                      Create rule
                    </Button>
                  )}
                </div>
                {isOpen && (
                  <div className="mt-2 p-3 border border-amber-300 rounded-md bg-background space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor={`mt-${rid}`} className="text-[11px]">Match type</Label>
                        <Select
                          value={matchType}
                          onValueChange={(v) => setMatchType((v ?? "contains") as "contains" | "exact" | "regex")}
                        >
                          <SelectTrigger id={`mt-${rid}`} className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="contains">contains</SelectItem>
                            <SelectItem value="exact">exact</SelectItem>
                            <SelectItem value="regex">regex</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`mv-${rid}`} className="text-[11px]">Match value (payee)</Label>
                        <Input
                          id={`mv-${rid}`}
                          value={matchValue}
                          onChange={(e) => setMatchValue(e.target.value)}
                          className="h-8 text-xs"
                          placeholder="e.g. STARBUCKS"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`cat-${rid}`} className="text-[11px]">Assign category</Label>
                      <Select
                        value={categoryId}
                        onValueChange={(v) => setCategoryId(v ?? "")}
                      >
                        <SelectTrigger id={`cat-${rid}`} className="h-8 text-xs">
                          <SelectValue placeholder="Pick a category…" />
                        </SelectTrigger>
                        <SelectContent>
                          {categories.map((c) => (
                            <SelectItem key={c.id} value={String(c.id)}>
                              {c.name} <span className="text-muted-foreground">({c.type})</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {formError && (
                      <p className="text-[11px] text-rose-700">{formError}</p>
                    )}
                    <div className="flex gap-2 justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={cancelForm}
                        disabled={submitting}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={submitRule}
                        disabled={submitting || !matchValue.trim() || !categoryId}
                      >
                        {submitting ? "Saving…" : "Create rule + apply"}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
