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
import { AlertCircle, AlertTriangle, BookTemplate, CheckCircle2, Copy } from "lucide-react";
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

interface ImportPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  validRows: PreviewRow[];
  duplicateRows: PreviewRow[];
  errorRows: Array<{ rowIndex: number; message: string }>;
  /** Issue #65: warning surface — these stay in valid and commit unless skipped. */
  probableDuplicates?: ProbableDuplicateMatch[];
  onConfirm: (rows: RawTransaction[], forceImportIndices: number[], skipIndices: number[]) => void;
  isImporting: boolean;
  csvHeaders?: string[];
  accounts?: string[];
  appliedTemplateId?: number | null;
  onTemplateSaved?: (template: { id: number; name: string }) => void;
}

export function ImportPreviewDialog({
  open,
  onOpenChange,
  validRows,
  duplicateRows,
  errorRows,
  probableDuplicates = [],
  onConfirm,
  isImporting,
  csvHeaders = [],
  accounts = [],
  appliedTemplateId,
  onTemplateSaved,
}: ImportPreviewDialogProps) {
  const [includeDuplicates, setIncludeDuplicates] = useState<Set<number>>(new Set());
  const [skipProbable, setSkipProbable] = useState<Set<number>>(new Set());
  const [expandedProbable, setExpandedProbable] = useState<Set<number>>(new Set());
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
      <DialogContent className="sm:max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
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
            <Badge variant="secondary" className="bg-amber-100 text-amber-800">
              <Copy className="h-3 w-3 mr-1" />
              {duplicateRows.length} duplicates
            </Badge>
          )}
          {probableDuplicates.length > 0 && (
            <Badge variant="secondary" className="bg-orange-100 text-orange-800">
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
            <Badge variant="outline" className="text-[10px] text-blue-700 border-blue-200 bg-blue-50">
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
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-orange-200 bg-orange-50/60 px-3 py-2 text-xs">
            <AlertTriangle className="h-3.5 w-3.5 text-orange-600" />
            <span className="text-orange-800">
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
                const rowClass = isDuplicate && !isForced
                  ? "opacity-50 bg-amber-50/50"
                  : isProbable
                    ? isSkipped
                      ? "opacity-60 bg-orange-50/30"
                      : "bg-orange-50/40"
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
                          <Badge variant="secondary" className="text-[10px] bg-amber-100 text-amber-700">
                            Duplicate
                          </Badge>
                        ) : isProbable ? (
                          <button
                            type="button"
                            onClick={() => toggleExpandProbable(row.rowIndex)}
                            className="inline-flex items-center gap-1"
                            title="Click to view match details"
                          >
                            <Badge variant="secondary" className="text-[10px] bg-orange-100 text-orange-700 cursor-pointer">
                              <AlertTriangle className="h-3 w-3 mr-0.5" />
                              Probable dup
                            </Badge>
                          </button>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] bg-emerald-100 text-emerald-700">
                            New
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                    {isProbable && isExpanded && probable && (
                      <TableRow key={`${row.rowIndex}-detail`} className="bg-orange-50/20">
                        <TableCell colSpan={7} className="text-[11px] text-orange-900 px-6 py-2">
                          <div className="space-y-0.5">
                            <div>
                              Matches existing transaction <span className="font-mono">#{probable.matchedTx.id}</span>
                              {probable.matchedTx.source && (
                                <> (source: <span className="font-mono">{probable.matchedTx.source}</span>)</>
                              )}
                            </div>
                            <div>
                              Existing: <span className="font-mono">{probable.matchedTx.date}</span> ${probable.matchedTx.amount.toFixed(2)} —
                              {" "}<span className="font-medium">{probable.matchedTx.daysOff}d</span> off,
                              {" "}delta ${probable.matchedTx.amountDeltaAbs.toFixed(2)} ({(probable.matchedTx.amountDeltaPct * 100).toFixed(2)}%)
                            </div>
                            <div className="text-orange-700">
                              Score {probable.matchScore.toFixed(2)} · {probable.matchReason}
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
          <div className="rounded-lg border border-rose-200 bg-rose-50/50 p-3 max-h-24 overflow-auto">
            <p className="text-xs font-medium text-rose-700 mb-1">Errors ({errorRows.length})</p>
            {errorRows.slice(0, 10).map((err) => (
              <p key={err.rowIndex} className="text-xs text-rose-600">
                Row {err.rowIndex + 1}: {err.message}
              </p>
            ))}
          </div>
        )}

        <DialogFooter>
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
