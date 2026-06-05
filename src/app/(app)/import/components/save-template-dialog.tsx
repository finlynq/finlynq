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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ColumnMapping, DateFormatOverride } from "@/lib/import-templates";
import { autoDetectColumnMapping } from "@/lib/import-templates";
import { SUPPORTED_CURRENCIES } from "@/lib/fx/supported-currencies";

type DateFormatUi = "auto" | DateFormatOverride;

interface SaveTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  csvHeaders: string[];
  accounts: string[];
  onSaved: (template: { id: number; name: string }) => void;
}

// flipSign is a boolean knob (rendered as a checkbox below), not a column
// dropdown, so it's excluded from the field→header label map.
type MappingColumnField = Exclude<keyof ColumnMapping, "flipSign">;

const FIELD_LABELS: Record<MappingColumnField, string> = {
  date: "Date *",
  amount: "Amount *",
  account: "Account",
  payee: "Payee / Description",
  category: "Category",
  currency: "Currency",
  note: "Note",
  tags: "Tags",
  balance: "Balance (running)",
};

const MAPPING_FIELDS = Object.keys(FIELD_LABELS) as MappingColumnField[];

export function SaveTemplateDialog({
  open,
  onOpenChange,
  csvHeaders,
  accounts,
  onSaved,
}: SaveTemplateDialogProps) {
  const [name, setName] = useState("");
  const [defaultAccount, setDefaultAccount] = useState("");
  const [mapping, setMapping] = useState<ColumnMapping>(() => {
    return autoDetectColumnMapping(csvHeaders) ?? { date: "", amount: "" };
  });
  const [skipHeaderRows, setSkipHeaderRows] = useState("0");
  const [skipFooterRows, setSkipFooterRows] = useState("0");
  const [dateFormatOverride, setDateFormatOverride] = useState<DateFormatUi>("auto");
  const [defaultCurrency, setDefaultCurrency] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset state when dialog opens
  const handleOpenChange = (val: boolean) => {
    if (val) {
      setName("");
      setDefaultAccount("");
      setMapping(autoDetectColumnMapping(csvHeaders) ?? { date: "", amount: "" });
      setSkipHeaderRows("0");
      setSkipFooterRows("0");
      setDateFormatOverride("auto");
      setDefaultCurrency("");
      setError("");
    }
    onOpenChange(val);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Template name is required");
      return;
    }
    if (!mapping.date) {
      setError("Date column is required");
      return;
    }
    if (!mapping.amount) {
      setError("Amount column is required");
      return;
    }

    setSaving(true);
    setError("");

    const skipH = Number.parseInt(skipHeaderRows, 10);
    const skipF = Number.parseInt(skipFooterRows, 10);

    try {
      const res = await fetch("/api/import/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          fileHeaders: csvHeaders,
          columnMapping: mapping,
          defaultAccount: defaultAccount || undefined,
          skipHeaderRows: Number.isFinite(skipH) ? Math.max(0, Math.min(100, skipH)) : 0,
          skipFooterRows: Number.isFinite(skipF) ? Math.max(0, Math.min(100, skipF)) : 0,
          dateFormatOverride: dateFormatOverride === "auto" ? null : dateFormatOverride,
          defaultCurrency: defaultCurrency || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onSaved({ id: data.id, name: data.name });
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  const setMappingField = (field: MappingColumnField, value: string) => {
    setMapping((prev) => ({ ...prev, [field]: value || undefined }));
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Save as Template</DialogTitle>
          <DialogDescription>
            Save this column mapping so future uploads from the same source are auto-matched.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Template Name</Label>
              <Input
                id="tpl-name"
                placeholder="e.g. TD Chequing, RBC Visa"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Default Account (optional)</Label>
              <Select value={defaultAccount} onValueChange={(v) => setDefaultAccount(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Leave blank to keep per-row account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a} value={a}>{a}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Column Mapping</Label>
            <p className="text-xs text-muted-foreground">Map CSV columns to transaction fields.</p>
            <div className="grid gap-2 sm:grid-cols-2 rounded-lg border p-2">
              {MAPPING_FIELDS.map((field) => (
                <div key={field} className="flex items-center gap-2 px-2 py-1.5">
                  <span className="w-28 text-xs text-muted-foreground shrink-0">
                    {FIELD_LABELS[field]}
                  </span>
                  <Select
                    value={mapping[field] ?? "__none__"}
                    onValueChange={(v) => setMappingField(field, (!v || v === "__none__") ? "" : v)}
                  >
                    <SelectTrigger className="h-7 text-xs flex-1">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— not mapped —</SelectItem>
                      {csvHeaders.map((h) => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          <details className="rounded-lg border bg-muted/30 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Import options (skip header / footer rows, date format, default currency)
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Apply these parser knobs whenever this template is used. Leave at defaults for canonical exports.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="save-tpl-skip-h" className="text-xs">Skip N header rows</Label>
                  <Input
                    id="save-tpl-skip-h"
                    type="number"
                    min={0}
                    max={100}
                    value={skipHeaderRows}
                    onChange={(e) => setSkipHeaderRows(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="save-tpl-skip-f" className="text-xs">Skip N footer rows</Label>
                  <Input
                    id="save-tpl-skip-f"
                    type="number"
                    min={0}
                    max={100}
                    value={skipFooterRows}
                    onChange={(e) => setSkipFooterRows(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Date format</Label>
                  <select
                    value={dateFormatOverride}
                    onChange={(e) => setDateFormatOverride(e.target.value as DateFormatUi)}
                    className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                    <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                    <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Default currency (rows missing one)</Label>
                  <Select
                    value={defaultCurrency || "__none__"}
                    onValueChange={(v) =>
                      setDefaultCurrency(!v || v === "__none__" ? "" : v)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="— None —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— None —</SelectItem>
                      {SUPPORTED_CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <label className="flex items-start gap-2.5 rounded-lg border bg-background px-3 py-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={mapping.flipSign === true}
                  onChange={(e) =>
                    setMapping((prev) => ({ ...prev, flipSign: e.target.checked }))
                  }
                  className="h-4 w-4 mt-0.5 rounded border-gray-300"
                />
                <span className="flex-1">
                  <span className="block text-sm font-medium">Flip sign of amounts</span>
                  <span className="block text-xs text-muted-foreground">
                    Multiply every amount by -1 on import. Use when this source
                    exports expenses as positive (or income as negative).
                  </span>
                </span>
              </label>
            </div>
          </details>

          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
