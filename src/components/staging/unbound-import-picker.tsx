"use client";

/**
 * UnboundImportPicker (2026-05-28)
 *
 * Renders inside /import/pending when a staged_imports row has
 * boundAccountId IS NULL AND headers IS NOT NULL — i.e. an email-import
 * CSV that didn't match any saved template at parse time. Before the user
 * binds the batch to an account, the per-account split view is empty (no
 * rows have account_name set), so this card REPLACES the pane layout on
 * the detail page until binding completes.
 *
 * Two paths:
 *   1. Pick a template → POST { templateId } to /api/import/staged/[id]/bind.
 *      Server resolves the template's defaultAccount to an accountId.
 *      400 if the template has no defaultAccount or the named account
 *      doesn't exist on the user's accounts.
 *   2. Bind to an account directly → POST { accountId }. Skips the
 *      template machinery entirely.
 *
 * On success the parent reloads detail (the picker disappears, panes
 * render normally with the now-populated account_name on every row).
 */

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mail, Sparkles, AlertCircle } from "lucide-react";

export interface PickerAccount {
  id: number;
  name: string;
  currency: string;
  isInvestment: boolean;
}

export interface PickerTemplate {
  id: number;
  name: string;
  defaultAccount: string | null;
  columnMapping: unknown;
  matchesHeaders: boolean;
}

export interface UnboundImportPickerProps {
  stagedImportId: string;
  headers: string[];
  sampleRows: Array<Record<string, string>>;
  accounts: PickerAccount[];
  templates: PickerTemplate[];
  fromAddress: string | null;
  subject: string | null;
  totalRowCount: number;
  /** Called after a successful bind so the parent can reload detail. */
  onBound: (result: { accountId: number; accountName: string; rowsRebound: number }) => void;
}

export function UnboundImportPicker({
  stagedImportId,
  headers,
  sampleRows,
  accounts,
  templates,
  fromAddress,
  subject,
  totalRowCount,
  onBound,
}: UnboundImportPickerProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Surface the best-match template at the top of the list with a badge.
  const sortedTemplates = useMemo(
    () =>
      [...templates].sort((a, b) =>
        a.matchesHeaders === b.matchesHeaders ? 0 : a.matchesHeaders ? -1 : 1,
      ),
    [templates],
  );

  const apply = async (body: { templateId?: number; accountId?: number }) => {
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch(`/api/import/staged/${stagedImportId}/bind`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data?.error ?? "Bind failed");
        return;
      }
      onBound(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/10">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600" />
          This email import didn&apos;t match any saved template
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1.5">
          <Mail className="h-3 w-3 inline mr-1" />
          From <span className="font-mono">{fromAddress ?? "(unknown)"}</span>
          {subject ? <> · &ldquo;{subject}&rdquo;</> : null}
          {" · "}
          {totalRowCount} row{totalRowCount === 1 ? "" : "s"} parsed by auto-detect
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ─── Preview of the CSV ──────────────────────────────────── */}
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">Preview</div>
          <div className="border rounded-md overflow-x-auto bg-background">
            <table className="text-xs w-full">
              <thead className="bg-muted/50">
                <tr>
                  {headers.map((h) => (
                    <th key={h} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleRows.length === 0 ? (
                  <tr>
                    <td className="px-2 py-2 text-muted-foreground italic" colSpan={headers.length}>
                      (no sample rows captured)
                    </td>
                  </tr>
                ) : (
                  sampleRows.map((row, i) => (
                    <tr key={i} className="border-t">
                      {headers.map((h) => (
                        <td key={h} className="px-2 py-1 whitespace-nowrap">
                          {row[h] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ─── Path 1: Pick a template ─────────────────────────────── */}
        {sortedTemplates.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">
              Apply a saved template (uses its default account)
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="border rounded-md px-2 py-1.5 text-sm bg-background flex-1 min-w-[200px]"
                value={selectedTemplateId ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setSelectedTemplateId(v ? Number(v) : null);
                  setSelectedAccountId(null);
                  setError(null);
                }}
                disabled={submitting}
              >
                <option value="">— Pick a template —</option>
                {sortedTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.matchesHeaders ? "  ★ matches headers" : ""}
                    {t.defaultAccount ? `  → ${t.defaultAccount}` : "  (no default account)"}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={selectedTemplateId == null || submitting}
                onClick={() =>
                  selectedTemplateId != null && apply({ templateId: selectedTemplateId })
                }
              >
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                Apply template
              </Button>
            </div>
          </div>
        )}

        {/* ─── Path 2: Bind to an account directly ─────────────────── */}
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">
            …or just bind to an account (skip template, no column remapping)
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="border rounded-md px-2 py-1.5 text-sm bg-background flex-1 min-w-[200px]"
              value={selectedAccountId ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setSelectedAccountId(v ? Number(v) : null);
                setSelectedTemplateId(null);
                setError(null);
              }}
              disabled={submitting}
            >
              <option value="">— Pick an account —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.currency})
                  {a.isInvestment ? " · investment" : ""}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedAccountId == null || submitting}
              onClick={() =>
                selectedAccountId != null && apply({ accountId: selectedAccountId })
              }
            >
              Bind to account
            </Button>
          </div>
        </div>

        {error && (
          <div className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </div>
        )}

        <Badge variant="outline" className="text-[10px] font-normal">
          Tip: if the auto-detected amounts or dates look wrong above, Discard this batch
          and re-send after saving a CSV template that matches your bank&apos;s format.
        </Badge>
      </CardContent>
    </Card>
  );
}
