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
import { AlertCircle, CheckCircle2, Copy } from "lucide-react";
import type { RawTransaction } from "@/lib/import-pipeline";

interface PreviewRow extends RawTransaction {
  hash: string;
  rowIndex: number;
}

interface ImportPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  validRows: PreviewRow[];
  duplicateRows: PreviewRow[];
  errorRows: Array<{ rowIndex: number; message: string }>;
  onConfirm: (rows: RawTransaction[], forceImportIndices: number[]) => void;
  isImporting: boolean;
}

export function ImportPreviewDialog({
  open,
  onOpenChange,
  validRows,
  duplicateRows,
  errorRows,
  onConfirm,
  isImporting,
}: ImportPreviewDialogProps) {
  const [includeDuplicates, setIncludeDuplicates] = useState<Set<number>>(new Set());

  const toggleDuplicate = (rowIndex: number) => {
    setIncludeDuplicates((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  };

  const allRows = [...validRows, ...duplicateRows].sort((a, b) => a.rowIndex - b.rowIndex);
  const duplicateIndices = new Set(duplicateRows.map((r) => r.rowIndex));

  const handleConfirm = () => {
    const allToImport = [...validRows, ...duplicateRows];
    const forceIndices = Array.from(includeDuplicates);
    onConfirm(allToImport, forceIndices);
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
        <div className="flex flex-wrap gap-2">
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
          {errorRows.length > 0 && (
            <Badge variant="destructive">
              <AlertCircle className="h-3 w-3 mr-1" />
              {errorRows.length} errors
            </Badge>
          )}
        </div>

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
                return (
                  <TableRow
                    key={row.rowIndex}
                    className={isDuplicate && !isForced ? "opacity-50 bg-amber-50/50" : ""}
                  >
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
                      ) : (
                        <Badge variant="secondary" className="text-[10px] bg-emerald-100 text-emerald-700">
                          New
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
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
            disabled={isImporting || (validRows.length === 0 && includeDuplicates.size === 0)}
          >
            {isImporting
              ? "Importing..."
              : `Import ${validRows.length + includeDuplicates.size} transactions`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
