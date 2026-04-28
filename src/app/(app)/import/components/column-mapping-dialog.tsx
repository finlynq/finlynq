"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { AlertCircle, Sparkles } from "lucide-react";
import type { ColumnMapping } from "@/lib/import-templates";

interface ColumnMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  suggestedMapping: ColumnMapping | null;
  accounts: string[];
  /** Submits the confirmed mapping. Parent handles the csv-map call + template save. */
  onConfirm: (params: {
    mapping: ColumnMapping;
    defaultAccount: string | null;
    templateName: string;
  }) => Promise<void>;
  submitting: boolean;
}

const FIELD_LABELS: Record<keyof ColumnMapping, string> = {
  date: "Date *",
  amount: "Amount *",
  account: "Account",
  payee: "Payee / Description",
  category: "Category",
  currency: "Currency",
  note: "Note",
  tags: "Tags",
};
const MAPPING_FIELDS = Object.keys(FIELD_LABELS) as (keyof ColumnMapping)[];
const NONE = "__none__";

/** Derive a sensible default template name from the file name. */
function defaultTemplateName(fileName: string): string {
  // "download-transactions (6).csv" → "download-transactions"
  const base = fileName.replace(/\.(csv|tsv|txt)$/i, "");
  return base.replace(/\s*\(\d+\)\s*$/, "").trim() || "My CSV Template";
}

export function ColumnMappingDialog({
  open,
  onOpenChange,
  fileName,
  headers,
  sampleRows,
  suggestedMapping,
  accounts,
  onConfirm,
  submitting,
}: ColumnMappingDialogProps) {
  const [mapping, setMapping] = useState<ColumnMapping>(
    () => suggestedMapping ?? { date: "", amount: "" },
  );
  const [defaultAccount, setDefaultAccount] = useState("");
  const [templateName, setTemplateName] = useState(() => defaultTemplateName(fileName));
  const [error, setError] = useState("");

  // Re-seed state whenever the dialog opens against a new file.
  useEffect(() => {
    if (!open) return;
    setMapping(suggestedMapping ?? { date: "", amount: "" });
    setDefaultAccount("");
    setTemplateName(defaultTemplateName(fileName));
    setError("");
  }, [open, suggestedMapping, fileName]);

  const setField = (field: keyof ColumnMapping, value: string) => {
    setMapping((prev) => ({ ...prev, [field]: value || undefined }));
  };

  const handleConfirm = async () => {
    setError("");
    if (!mapping.date) { setError("Pick the Date column."); return; }
    if (!mapping.amount) { setError("Pick the Amount column."); return; }
    if (!mapping.account && !defaultAccount) {
      setError("Map an Account column, or pick a Default Account below.");
      return;
    }
    if (!templateName.trim()) { setError("Give the template a name."); return; }

    await onConfirm({
      mapping,
      defaultAccount: defaultAccount || null,
      templateName: templateName.trim(),
    });
  };

  // Compute a live sample using the current mapping so the user sees what
  // each column resolves to before committing.
  const mappedSample = useMemo(() => {
    return sampleRows.slice(0, 3).map((row) => ({
      date: mapping.date ? row[mapping.date] ?? "" : "",
      amount: mapping.amount ? row[mapping.amount] ?? "" : "",
      payee: mapping.payee ? row[mapping.payee] ?? "" : "",
      account: mapping.account
        ? row[mapping.account] ?? ""
        : defaultAccount || "(default account)",
    }));
  }, [sampleRows, mapping, defaultAccount]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Map CSV Columns</DialogTitle>
          <DialogDescription>
            We couldn&apos;t auto-match the columns in{" "}
            <span className="font-mono text-xs">{fileName}</span>.
            Tell us which column is which — we&apos;ll remember the mapping for next time.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-auto flex-1 space-y-4 pr-1">
          {suggestedMapping && (
            <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50/40 p-2.5">
              <Sparkles className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
              <p className="text-xs text-blue-800">
                We&apos;ve pre-filled our best guesses. Double-check Date, Amount, and Account
                before continuing.
              </p>
            </div>
          )}

          {/* Mapping table */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Column Mapping</Label>
            <div className="rounded-lg border divide-y">
              {MAPPING_FIELDS.map((field) => (
                <div key={field} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-36 text-xs text-muted-foreground shrink-0">
                    {FIELD_LABELS[field]}
                  </span>
                  <Select
                    value={mapping[field] ?? NONE}
                    onValueChange={(v) => setField(field, (!v || v === NONE) ? "" : v)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— not mapped —</SelectItem>
                      {headers.map((h) => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          {/* Default account */}
          <div className="space-y-1.5">
            <Label className="text-sm">Default Account</Label>
            <p className="text-xs text-muted-foreground">
              Used when the Account column is not mapped, or when a row&apos;s account cell is empty.
            </p>
            <Select value={defaultAccount} onValueChange={(v) => setDefaultAccount(v ?? "")}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="— none —" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Live sample */}
          {mappedSample.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-sm">Sample (first 3 rows)</Label>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium">Date</th>
                      <th className="text-left px-2 py-1.5 font-medium">Account</th>
                      <th className="text-left px-2 py-1.5 font-medium">Payee</th>
                      <th className="text-right px-2 py-1.5 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {mappedSample.map((r, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1 font-mono">{r.date || "—"}</td>
                        <td className="px-2 py-1">{r.account || "—"}</td>
                        <td className="px-2 py-1 truncate max-w-[220px]">{r.payee || "—"}</td>
                        <td className="px-2 py-1 text-right font-mono">{r.amount || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Template name */}
          <div className="space-y-1.5">
            <Label htmlFor="col-map-tpl-name" className="text-sm">
              Save this mapping as a template
            </Label>
            <Input
              id="col-map-tpl-name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="e.g. CIBC Mastercard"
              className="h-8 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Future uploads with the same columns will use this mapping automatically.
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-2">
              <AlertCircle className="h-4 w-4 text-rose-600 shrink-0" />
              <p className="text-xs text-rose-700">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={submitting}>
            {submitting ? "Preparing preview..." : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
