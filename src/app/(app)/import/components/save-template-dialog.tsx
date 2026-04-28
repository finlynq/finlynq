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
import type { ColumnMapping } from "@/lib/import-templates";
import { autoDetectColumnMapping } from "@/lib/import-templates";

interface SaveTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  csvHeaders: string[];
  accounts: string[];
  onSaved: (template: { id: number; name: string }) => void;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset state when dialog opens
  const handleOpenChange = (val: boolean) => {
    if (val) {
      setName("");
      setDefaultAccount("");
      setMapping(autoDetectColumnMapping(csvHeaders) ?? { date: "", amount: "" });
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

    try {
      const res = await fetch("/api/import/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          fileHeaders: csvHeaders,
          columnMapping: mapping,
          defaultAccount: defaultAccount || undefined,
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

  const setMappingField = (field: keyof ColumnMapping, value: string) => {
    setMapping((prev) => ({ ...prev, [field]: value || undefined }));
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save as Template</DialogTitle>
          <DialogDescription>
            Save this column mapping so future uploads from the same source are auto-matched.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
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

          <div className="space-y-2">
            <Label className="text-sm font-medium">Column Mapping</Label>
            <p className="text-xs text-muted-foreground">Map CSV columns to transaction fields.</p>
            <div className="rounded-lg border divide-y">
              {MAPPING_FIELDS.map((field) => (
                <div key={field} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-36 text-xs text-muted-foreground shrink-0">
                    {FIELD_LABELS[field]}
                  </span>
                  <Select
                    value={mapping[field] ?? "__none__"}
                    onValueChange={(v) => setMappingField(field, (!v || v === "__none__") ? "" : v)}
                  >
                    <SelectTrigger className="h-7 text-xs">
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
