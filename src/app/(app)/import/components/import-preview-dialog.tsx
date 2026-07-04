"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertCircle, AlertTriangle, ArrowLeft, BookTemplate, CheckCircle2, Copy } from "lucide-react";
import type { RawTransaction } from "@/lib/import-pipeline";
import { SaveTemplateDialog } from "./save-template-dialog";

interface PreviewRow extends RawTransaction {
  hash: string;
  rowIndex: number;
}

/** Issue #65: probable-duplicate match flagged by the cross-source detector. */
export interface ProbableDuplicateMatch {
  rowIndex: number;
  matchedTransactionId: number;
  matchScore: number;
  matchReason: string;
  matchedTx: {
    id: number;
    date: string;
    amount: number;
    source: string | null;
    daysOff: number;
    amountDeltaPct: number;
    amountDeltaAbs: number;
  };
}

/** Exact-match duplicate (fitId or import_hash) — surfaced for UI explanation. */
export interface ExactDuplicateMatch {
  rowIndex: number;
  matchBasis: "fit_id" | "import_hash";
  matchedTx: {
    id: number;
    date: string;
    amount: number;
    source: string | null;
  };
}

interface ImportPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  validRows: PreviewRow[];
  duplicateRows: PreviewRow[];
  errorRows: Array<{ rowIndex: number; message: string }>;
  /** Per-row "Matches existing transaction #X" detail for exact duplicates. */
  duplicateMatches?: ExactDuplicateMatch[];
  /** Issue #65: warning surface — these stay in valid and commit unless skipped. */
  probableDuplicates?: ProbableDuplicateMatch[];
  onConfirm: (rows: RawTransaction[], forceImportIndices: number[], skipIndices: number[]) => void;
  isImporting: boolean;
  csvHeaders?: string[];
  accounts?: string[];
  appliedTemplateId?: number | null;
  /** Optional — when provided, the dialog renders a "Change template" button
   *  that lets the user pop back to the template picker for this same file. */
  onChangeTemplate?: () => void;
  onTemplateSaved?: (template: { id: number; name: string }) => void;
}

export function ImportPreviewDialog({
  open,
  onOpenChange,
  validRows,
  duplicateRows,
  errorRows,
  duplicateMatches = [],
  probableDuplicates = [],
  onConfirm,
  isImporting,
  csvHeaders = [],
  accounts = [],
  appliedTemplateId,
  onChangeTemplate,
  onTemplateSaved,
}: ImportPreviewDialogProps) {
  const [includeDuplicates, setIncludeDuplicates] = useState<Set<number>>(new Set());
  const [skipProbable, setSkipProbable] = useState<Set<number>>(new Set());
  const [expandedProbable, setExpandedProbable] = useState<Set<number>>(new Set());
  const [expandedDuplicate, setExpandedDuplicate] = useState<Set<number>>(new Set());
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);

  const toggleDuplicate = (rowIndex: number) => {
    setIncludeDuplicates((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  };

  const toggleSkipProbable = (rowIndex: number) => {
    setSkipProbable((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  };

  const toggleExpandProbable = (rowIndex: number) => {
    setExpandedProbable((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  };

  const toggleExpandDuplicate = (rowIndex: number) => {
    setExpandedDuplicate((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  };

  const skipAllProbable = () => {
    setSkipProbable(new Set(probableDuplicates.map((p) => p.rowIndex)));
  };

  const commitAllProbable = () => {
    setSkipProbable(new Set());
  };

  const allRows = [...validRows, ...duplicateRows].sort((a, b) => a.rowIndex - b.rowIndex);
  const duplicateIndices = new Set(duplicateRows.map((r) => r.rowIndex));
  const probableByRowIndex = new Map<number, ProbableDuplicateMatch>();
  for (const p of probableDuplicates) probableByRowIndex.set(p.rowIndex, p);
  const duplicateByRowIndex = new Map<number, ExactDuplicateMatch>();
  for (const d of duplicateMatches) duplicateByRowIndex.set(d.rowIndex, d);

  const probableNotSkipped = probableDuplicates.length - skipProbable.size;
  const importCount = validRows.length - skipProbable.size + includeDuplicates.size;

  const handleConfirm = () => {
    const allToImport = [...validRows, ...duplicateRows];
    const forceIndices = Array.from(includeDuplicates);
    const skipIndices = Array.from(skipProbable);
    onConfirm(allToImport, forceIndices, skipIndices);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Import Preview</DialogTitle>
          <DialogDescription>
            Review the parsed transactions before importing.
          </DialogDescription>
        </DialogHeader>

        {/* Summary badges */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="default" className="bg-emerald-600">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            {validRows.length} new
          </Badge>
          {duplicateRows.length > 0 && (
            <Badge variant="secondary" className="bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">
              <Copy className="h-3 w-3 mr-1" />
              {duplicateRows.length} duplicates
            </Badge>
          )}
          {probableDuplicates.length > 0 && (
            <Badge variant="secondary" className="bg-orange-500/20 text-orange-700 dark:text-orange-300 border border-orange-500/30">
              <AlertTriangle className="h-3 w-3 mr-1" />
              {probableDuplicates.length} probable duplicates
            </Badge>
          )}
          {errorRows.length > 0 && (
            <Badge variant="destructive">
              <AlertCircle className="h-3 w-3 mr-1" />
              {errorRows.length} errors
            </Badge>
          )}
          {appliedTemplateId && (
            <Badge variant="outline" className="text-[10px] text-blue-700 dark:text-blue-300 border-blue-500/30 bg-blue-500/15">
              Template applied
            </Badge>
          )}
          {csvHeaders.length > 0 && !appliedTemplateId && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs ml-auto"
              onClick={() => setSaveTemplateOpen(true)}
            >
              <BookTemplate className="h-3 w-3 mr-1" />
              Save as Template
            </Button>
          )}
        </div>

        {/* Issue #65: probable-duplicate bulk-action bar. Shown when the
            cross-source detector flagged any rows. Probable duplicates default
            to "commit anyway" (this is a warning, not a hard block) so the
            user can skip-all if they want every flagged row gone in one click. */}
        {probableDuplicates.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
            <span className="text-orange-700 dark:text-orange-300 font-medium">
              {probableNotSkipped} of {probableDuplicates.length} probable duplicates will be imported
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px]"
                onClick={skipAllProbable}
                disabled={skipProbable.size === probableDuplicates.length}
              >
                Skip all
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px]"
                onClick={commitAllProbable}
                disabled={skipProbable.size === 0}
              >
                Commit all
              </Button>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="overflow-auto flex-1 rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Payee</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allRows.slice(0, 100).map((row) => {
                const isDuplicate = duplicateIndices.has(row.rowIndex);
                const isForced = includeDuplicates.has(row.rowIndex);
                const probable = probableByRowIndex.get(row.rowIndex);
                const isProbable = !isDuplicate && !!probable;
                const isSkipped = isProbable && skipProbable.has(row.rowIndex);
                const isExpanded = isProbable && expandedProbable.has(row.rowIndex);
                const dupMatch = isDuplicate ? duplicateByRowIndex.get(row.rowIndex) : undefined;
                const isDupExpanded = isDuplicate && expandedDuplicate.has(row.rowIndex);
                const rowClass = isDuplicate && !isForced
                  ? "bg-amber-500/10 text-muted-foreground"
                  : isProbable
                    ? isSkipped
                      ? "bg-orange-500/5 text-muted-foreground"
                      : "bg-orange-500/10"
                    : "";
                return (
                  <>
                    <TableRow key={row.rowIndex} className={rowClass}>
                      <TableCell>
                        {isDuplicate && (
                          <input
                            type="checkbox"
                            checked={isForced}
                            onChange={() => toggleDuplicate(row.rowIndex)}
                            className="h-4 w-4 rounded border-gray-300"
                            title="Force import this duplicate"
                          />
                        )}
                        {isProbable && (
                          <input
                            type="checkbox"
                            checked={!isSkipped}
                            onChange={() => toggleSkipProbable(row.rowIndex)}
                            className="h-4 w-4 rounded border-orange-400"
                            title="Uncheck to skip this probable duplicate"
                          />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.date}</TableCell>
                      <TableCell className="text-xs">{row.account}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate">{row.payee}</TableCell>
                      <TableCell className={`text-right font-mono text-xs ${row.amount < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                        {row.amount.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-xs">{row.category || "—"}</TableCell>
                      <TableCell>
                        {isDuplicate ? (
                          dupMatch ? (
                            <button
                              type="button"
                              onClick={() => toggleExpandDuplicate(row.rowIndex)}
                              className="inline-flex items-center gap-1"
                              title="Click to view match details"
                            >
                              <Badge variant="secondary" className="text-[10px] bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30 cursor-pointer hover:bg-amber-500/30">
                                Duplicate
                              </Badge>
                            </button>
                          ) : (
                            <Badge variant="secondary" className="text-[10px] bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                              Duplicate
                            </Badge>
                          )
                        ) : isProbable ? (
                          <button
                            type="button"
                            onClick={() => toggleExpandProbable(row.rowIndex)}
                            className="inline-flex items-center gap-1"
                            title="Click to view match details"
                          >
                            <Badge variant="secondary" className="text-[10px] bg-orange-500/20 text-orange-700 dark:text-orange-300 border border-orange-500/30 cursor-pointer hover:bg-orange-500/30">
                              <AlertTriangle className="h-3 w-3 mr-0.5" />
                              Probable dup
                            </Badge>
                          </button>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                            New
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                    {isProbable && isExpanded && probable && (
                      <TableRow key={`${row.rowIndex}-detail`} className="bg-orange-500/10 border-l-2 border-orange-500/50">
                        <TableCell colSpan={7} className="text-xs text-foreground px-6 py-3">
                          <div className="space-y-1">
                            <div>
                              Matches existing transaction <span className="font-mono text-orange-700 dark:text-orange-300">#{probable.matchedTx.id}</span>
                              {probable.matchedTx.source && (
                                <> (source: <span className="font-mono">{probable.matchedTx.source}</span>)</>
                              )}
                            </div>
                            <div className="text-muted-foreground">
                              Existing: <span className="font-mono text-foreground">{probable.matchedTx.date}</span> <span className="font-mono text-foreground">${probable.matchedTx.amount.toFixed(2)}</span> —
                              {" "}<span className="font-medium text-foreground">{probable.matchedTx.daysOff}d</span> off,
                              {" "}delta <span className="font-mono text-foreground">${probable.matchedTx.amountDeltaAbs.toFixed(2)}</span> ({(probable.matchedTx.amountDeltaPct * 100).toFixed(2)}%)
                            </div>
                            <div className="text-orange-700 dark:text-orange-300 font-medium">
                              Score {probable.matchScore.toFixed(2)} · {probable.matchReason}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    {isDuplicate && isDupExpanded && dupMatch && (
                      <TableRow key={`${row.rowIndex}-dup-detail`} className="bg-amber-500/10 border-l-2 border-amber-500/50">
                        <TableCell colSpan={7} className="text-xs text-foreground px-6 py-3">
                          <div className="space-y-1">
                            <div>
                              {dupMatch.matchedTx.id != null ? (
                                <>
                                  Matches existing transaction <span className="font-mono text-amber-700 dark:text-amber-300">#{dupMatch.matchedTx.id}</span>
                                </>
                              ) : (
                                <span className="text-amber-700 dark:text-amber-300">Previously imported (no current transaction)</span>
                              )}
                              {dupMatch.matchedTx.source && (
                                <> (source: <span className="font-mono">{dupMatch.matchedTx.source}</span>)</>
                              )}
                            </div>
                            <div className="text-muted-foreground">
                              Existing: <span className="font-mono text-foreground">{dupMatch.matchedTx.date}</span> <span className="font-mono text-foreground">${dupMatch.matchedTx.amount.toFixed(2)}</span>
                            </div>
                            <div className="text-amber-700 dark:text-amber-300 font-medium">
                              {dupMatch.matchBasis === "fit_id"
                                ? "Exact match · bank-provided fitId"
                                : "Exact match · date + account + amount + payee"}
                              {!isForced && " · check the box above to import anyway"}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })}
              {allRows.length > 100 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-4">
                    Showing first 100 of {allRows.length} rows
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {/* Errors */}
        {errorRows.length > 0 && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 max-h-32 overflow-auto">
            <p className="text-xs font-medium text-rose-700 dark:text-rose-300 mb-1">Errors ({errorRows.length})</p>
            {errorRows.slice(0, 10).map((err) => (
              <p key={err.rowIndex} className="text-xs text-rose-700 dark:text-rose-300/90">
                Row {err.rowIndex + 1}: {err.message}
              </p>
            ))}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <div>
            {onChangeTemplate && (
              <Button
                variant="ghost"
                onClick={onChangeTemplate}
                disabled={isImporting}
                className="text-xs"
              >
                <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                Change template
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isImporting}>
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={isImporting || (importCount === 0)}
            >
              {isImporting
                ? "Importing..."
                : `Import ${importCount} transactions`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>

      {csvHeaders.length > 0 && (
        <SaveTemplateDialog
          open={saveTemplateOpen}
          onOpenChange={setSaveTemplateOpen}
          csvHeaders={csvHeaders}
          accounts={accounts}
          onSaved={(t) => {
            onTemplateSaved?.(t);
            setSaveTemplateOpen(false);
          }}
        />
      )}
    </Dialog>
  );
}
