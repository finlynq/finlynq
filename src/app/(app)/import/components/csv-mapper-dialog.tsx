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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowRight, FileText } from "lucide-react";

const FIELD_OPTIONS = [
  { value: "", label: "Skip" },
  { value: "date", label: "Date *" },
  { value: "amount", label: "Amount *" },
  { value: "account", label: "Account" },
  { value: "payee", label: "Payee / Description" },
  { value: "category", label: "Category" },
  { value: "currency", label: "Currency" },
  { value: "note", label: "Note" },
  { value: "tags", label: "Tags" },
  { value: "quantity", label: "Quantity" },
  { value: "portfolioHolding", label: "Portfolio Holding" },
];

function autoDetectField(header: string): string {
  const h = header.toLowerCase();
  if (h.includes("date") || h.includes("posted")) return "date";
  if (h.includes("amount") || h.includes("total") || h.includes("debit") || h.includes("credit")) return "amount";
  if (h.includes("account")) return "account";
  if (h.includes("payee") || h.includes("description") || h.includes("merchant") || h.includes("memo")) return "payee";
  if (h.includes("categor")) return "category";
  if (h.includes("currency")) return "currency";
  if (h.includes("note") || h.includes("reference")) return "note";
  if (h.includes("tag")) return "tags";
  return "";
}

interface CsvMapperDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  headers: string[];
  file: File;
  accounts: string[];
  onMapped: (mapping: Record<string, string>, defaultAccount: string) => void;
  isMapping: boolean;
}

export function CsvMapperDialog({
  open,
  onOpenChange,
  headers,
  file,
  accounts,
  onMapped,
  isMapping,
}: CsvMapperDialogProps) {
  // mapping: { headerName → fieldKey }  (e.g. "Transaction Date" → "date")
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [defaultAccount, setDefaultAccount] = useState("");

  useEffect(() => {
    if (!open) return;
    const auto: Record<string, string> = {};
    headers.forEach((h) => {
      const field = autoDetectField(h);
      if (field) auto[h] = field;
    });
    setMapping(auto);
  }, [open, headers]);

  const updateMapping = (header: string, field: string) => {
    setMapping((prev) => ({ ...prev, [header]: field }));
  };

  const hasDate = Object.values(mapping).includes("date");
  const hasAmount = Object.values(mapping).includes("amount");
  const hasAccount = Object.values(mapping).includes("account");
  const isValid = hasDate && hasAmount && (hasAccount || defaultAccount.trim() !== "");

  const handleSubmit = () => {
    // Convert from { header → field } to { field → header } for the API
    const apiMapping: Record<string, string> = {};
    for (const [header, field] of Object.entries(mapping)) {
      if (field) apiMapping[field] = header;
    }
    onMapped(apiMapping, defaultAccount.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Map CSV Columns
          </DialogTitle>
          <DialogDescription>
            Map the columns in <span className="font-medium">{file.name}</span> to transaction fields.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-auto flex-1 space-y-3 pr-1">
          <p className="text-xs text-muted-foreground font-medium">Column Mapping</p>
          {headers.map((header) => (
            <div key={header} className="flex items-center gap-2">
              <Badge variant="outline" className="min-w-[140px] justify-center font-mono text-xs shrink-0 truncate">
                {header}
              </Badge>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Select value={mapping[header] ?? ""} onValueChange={(v) => updateMapping(header, v === "_skip" ? "" : v)}>
                <SelectTrigger className="w-52" size="sm">
                  <SelectValue placeholder="Skip" />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value || "_skip"} value={opt.value || "_skip"}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}

          {!hasAccount && (
            <div className="mt-4 space-y-1.5">
              <p className="text-xs font-medium">Default Account</p>
              <p className="text-xs text-muted-foreground">
                Required when your CSV has no Account column.
              </p>
              {accounts.length > 0 ? (
                <Select value={defaultAccount} onValueChange={(v) => setDefaultAccount(v ?? "")}>
                  <SelectTrigger className="w-60">
                    <SelectValue placeholder="Select account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a} value={a}>{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  placeholder="Account name"
                  value={defaultAccount}
                  onChange={(e) => setDefaultAccount(e.target.value)}
                  className="w-60"
                />
              )}
            </div>
          )}
        </div>

        {(!hasDate || !hasAmount) && (
          <p className="text-xs text-amber-600">
            {!hasDate && "Date mapping is required. "}
            {!hasAmount && "Amount mapping is required."}
          </p>
        )}
        {hasDate && hasAmount && !hasAccount && defaultAccount.trim() === "" && (
          <p className="text-xs text-amber-600">
            Select a default account or map an Account column.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isMapping}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isMapping}>
            {isMapping ? "Processing…" : "Preview Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
