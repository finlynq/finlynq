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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FileSpreadsheet, ArrowRight } from "lucide-react";

interface SheetInfo {
  name: string;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
}

interface ExcelMapperDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheets: SheetInfo[];
  file: File;
  onMapped: (sheetName: string, mapping: Record<string, string>, hasHeaders: boolean) => void;
  isMapping: boolean;
}

const FIELD_OPTIONS = [
  { value: "", label: "Skip" },
  { value: "date", label: "Date" },
  { value: "amount", label: "Amount" },
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
  if (h.includes("category") || h.includes("categorization")) return "category";
  if (h.includes("currency")) return "currency";
  if (h.includes("note") || h.includes("reference")) return "note";
  if (h.includes("tag")) return "tags";
  return "";
}

export function ExcelMapperDialog({
  open,
  onOpenChange,
  sheets,
  file,
  onMapped,
  isMapping,
}: ExcelMapperDialogProps) {
  const [selectedSheet, setSelectedSheet] = useState(sheets[0]?.name ?? "");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [hasHeaders, setHasHeaders] = useState(true);

  const sheet = sheets.find((s) => s.name === selectedSheet);

  // Auto-detect mappings when sheet changes
  useEffect(() => {
    if (!sheet) return;
    const auto: Record<string, string> = {};
    sheet.headers.forEach((h) => {
      const field = autoDetectField(h);
      if (field) auto[h] = field;
    });
    setMapping(auto);
  }, [selectedSheet, sheet]);

  const updateMapping = (header: string, field: string | null) => {
    setMapping((prev) => ({ ...prev, [header]: field ?? "" }));
  };

  const hasDate = Object.values(mapping).includes("date");
  const hasAmount = Object.values(mapping).includes("amount");
  const isValid = hasDate && hasAmount;

  const handleSubmit = () => {
    // Convert to the format expected by the API: { date: "Column Name", amount: "Column Name" }
    const apiMapping: Record<string, string> = {};
    for (const [header, field] of Object.entries(mapping)) {
      if (field) apiMapping[field] = header;
    }
    onMapped(selectedSheet, apiMapping, hasHeaders);
  };

  if (!sheet) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
            Map Excel Columns
          </DialogTitle>
          <DialogDescription>
            Map your spreadsheet columns to transaction fields.
          </DialogDescription>
        </DialogHeader>

        {/* Sheet selector */}
        {sheets.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Sheet:</span>
            <Select value={selectedSheet} onValueChange={(v) => setSelectedSheet(v ?? "")}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sheets.map((s) => (
                  <SelectItem key={s.name} value={s.name}>
                    {s.name} ({s.totalRows} rows)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Headers toggle */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasHeaders}
            onChange={(e) => setHasHeaders(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          First row contains headers
        </label>

        {/* Column mapping */}
        <div className="space-y-2 overflow-auto flex-1">
          <p className="text-xs text-muted-foreground font-medium">Column Mapping</p>
          {sheet.headers.map((header) => (
            <div key={header} className="flex items-center gap-2">
              <Badge variant="outline" className="min-w-[120px] justify-center font-mono text-xs">
                {header}
              </Badge>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Select value={mapping[header] ?? ""} onValueChange={(v) => updateMapping(header, v)}>
                <SelectTrigger className="w-48" size="sm">
                  <SelectValue placeholder="Skip" />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value || "_skip"}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>

        {/* Sample data preview */}
        {sheet.sampleRows.length > 0 && (
          <div className="overflow-auto rounded-lg border max-h-36">
            <Table>
              <TableHeader>
                <TableRow>
                  {sheet.headers.map((h) => (
                    <TableHead key={h} className="text-xs py-1">{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sheet.sampleRows.map((row, i) => (
                  <TableRow key={i}>
                    {row.map((cell, j) => (
                      <TableCell key={j} className="text-xs py-1 max-w-[150px] truncate">
                        {cell}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Validation */}
        {!isValid && (
          <p className="text-xs text-amber-600">
            {!hasDate && "Date mapping is required. "}
            {!hasAmount && "Amount mapping is required."}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isMapping}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isMapping}>
            {isMapping ? "Processing..." : "Preview Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
