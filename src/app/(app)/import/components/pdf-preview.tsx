"use client";

import { useState, useEffect } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { File, Eye, ArrowRight } from "lucide-react";
import type { RawTransaction } from "@/lib/import-pipeline";

interface PdfPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: RawTransaction[];
  confidence: number;
  rawText: string;
  accounts: string[];
  onConfirm: (rows: RawTransaction[]) => void;
}

export function PdfPreview({
  open,
  onOpenChange,
  rows,
  confidence,
  rawText,
  accounts,
  onConfirm,
}: PdfPreviewProps) {
  const [selectedAccount, setSelectedAccount] = useState("");
  const [showRawText, setShowRawText] = useState(false);

  // Reset on open
  useEffect(() => {
    if (open) {
      setSelectedAccount("");
      setShowRawText(false);
    }
  }, [open]);

  const confidencePct = Math.round(confidence * 100);
  const confidenceColor =
    confidencePct >= 70 ? "bg-emerald-100 text-emerald-700" :
    confidencePct >= 40 ? "bg-amber-100 text-amber-700" :
    "bg-rose-100 text-rose-700";

  const handleConfirm = () => {
    // Assign the selected account to all rows that don't have one
    const mapped = rows.map((r) => ({
      ...r,
      account: r.account || selectedAccount,
    }));
    onConfirm(mapped);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <File className="h-5 w-5 text-blue-600" />
            PDF Import Preview
          </DialogTitle>
          <DialogDescription>
            {rows.length} transactions extracted from the PDF.
          </DialogDescription>
        </DialogHeader>

        {/* Confidence + account selector */}
        <div className="flex flex-wrap items-center gap-3">
          <Badge className={confidenceColor}>
            Confidence: {confidencePct}%
          </Badge>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Assign to account:</span>
            <Select value={selectedAccount} onValueChange={(v) => setSelectedAccount(v ?? "")}>
              <SelectTrigger className="w-48" size="sm">
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((acc) => (
                  <SelectItem key={acc} value={acc}>{acc}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Toggle between parsed and raw */}
        <div className="flex items-center gap-2">
          <Button
            variant={showRawText ? "outline" : "default"}
            size="sm"
            onClick={() => setShowRawText(false)}
          >
            Parsed ({rows.length})
          </Button>
          <Button
            variant={showRawText ? "default" : "outline"}
            size="sm"
            onClick={() => setShowRawText(true)}
          >
            <Eye className="h-3.5 w-3.5 mr-1" />
            Raw Text
          </Button>
        </div>

        {/* Content */}
        <div className="overflow-auto flex-1 rounded-lg border">
          {showRawText ? (
            <pre className="p-3 text-xs whitespace-pre-wrap font-mono text-muted-foreground leading-relaxed">
              {rawText}
            </pre>
          ) : (
            <div className="divide-y">
              {rows.slice(0, 100).map((row, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <span className="font-mono text-muted-foreground w-20 shrink-0">{row.date}</span>
                  <span className="flex-1 truncate">{row.payee}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className={`font-mono w-20 text-right shrink-0 ${row.amount < 0 ? "text-rose-600" : "text-emerald-600"}`}>
                    {row.amount.toFixed(2)}
                  </span>
                </div>
              ))}
              {rows.length > 100 && (
                <div className="text-center text-xs text-muted-foreground py-3">
                  Showing first 100 of {rows.length} rows
                </div>
              )}
              {rows.length === 0 && (
                <div className="text-center text-sm text-muted-foreground py-8">
                  No transactions could be extracted. Check the raw text tab.
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={rows.length === 0 || !selectedAccount}
          >
            {!selectedAccount ? "Select an account first" : `Preview ${rows.length} transactions`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
