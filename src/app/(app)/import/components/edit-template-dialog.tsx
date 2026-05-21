"use client";

import { useEffect, useState } from "react";
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
import type { ColumnMapping, ImportTemplate } from "@/lib/import-templates";

interface EditTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: ImportTemplate | null;
  accounts: string[];
  onSaved: (template: ImportTemplate) => void;
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

const NONE_ACCOUNT = "__none_account__";

export function EditTemplateDialog({
  open,
  onOpenChange,
  template,
  accounts,
  onSaved,
}: EditTemplateDialogProps) {
  const [name, setName] = useState("");
  const [defaultAccount, setDefaultAccount] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [mapping, setMapping] = useState<ColumnMapping>({ date: "", amount: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Re-seed local state whenever the dialog opens with a (possibly different) template.
  useEffect(() => {
    if (open && template) {
      setName(template.name);
      setDefaultAccount(template.defaultAccount ?? "");
      setIsDefault(template.isDefault);
      setMapping({ ...template.columnMapping });
      setError("");
    }
  }, [open, template]);

  const handleSave = async () => {
    if (!template) return;
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
      const res = await fetch(`/api/import/templates/${template.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          defaultAccount: defaultAccount ? defaultAccount : null,
          isDefault,
          columnMapping: mapping,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onSaved(data as ImportTemplate);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update template");
    } finally {
      setSaving(false);
    }
  };

  const setMappingField = (field: keyof ColumnMapping, value: string) => {
    setMapping((prev) => ({ ...prev, [field]: value || undefined }));
  };

  const csvHeaders = template?.fileHeaders ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Template</DialogTitle>
          <DialogDescription>
            Update this template&apos;s name, default account, and column mapping.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-tpl-name">Template Name</Label>
            <Input
              id="edit-tpl-name"
              placeholder="e.g. TD Chequing, RBC Visa"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Default Account (optional)</Label>
            <Select
              value={defaultAccount || NONE_ACCOUNT}
              onValueChange={(v) =>
                setDefaultAccount(!v || v === NONE_ACCOUNT ? "" : v)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Leave blank to keep per-row account" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_ACCOUNT}>— none —</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start gap-3 rounded-lg border px-3 py-2.5">
            <input
              id="edit-tpl-default"
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 mt-0.5 rounded border-gray-300"
            />
            <div className="flex-1">
              <Label htmlFor="edit-tpl-default" className="cursor-pointer text-sm font-medium">
                Default template
              </Label>
              <p className="text-xs text-muted-foreground">
                Auto-apply this template when headers match.
              </p>
            </div>
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
                    onValueChange={(v) =>
                      setMappingField(field, (!v || v === "__none__") ? "" : v)
                    }
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
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
