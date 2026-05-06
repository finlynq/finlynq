"use client";

import { useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import { FileDropZone } from "@/app/(app)/import/components/file-drop-zone";
import { Loader2 } from "lucide-react";

import type { AccountOption } from "./preview-table";

export interface TemplateOption {
  id: number;
  name: string;
}

interface Props {
  accounts: AccountOption[];
  templates?: TemplateOption[];
  loading: boolean;
  onUpload: (params: {
    file: File;
    accountId: number | null;
    tolerance: number;
    templateId: number | null;
    /** Optional user-typed statement balance for CSV uploads. OFX/QFX
     *  statements carry their own balance via <LEDGERBAL>, so this is
     *  primarily for CSVs where no balance is reliably parseable. */
    statementBalance: number | null;
  }) => void;
}

const ACCEPT = ".csv,.ofx,.qfx";

export function ReconcileUploadCard({
  accounts,
  templates = [],
  loading,
  onUpload,
}: Props) {
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [tolerance, setTolerance] = useState<string>("3");
  const [statementBalance, setStatementBalance] = useState<string>("");

  const accountItems = accounts.map((a) => ({
    value: String(a.id),
    label: `${a.name} (${a.currency})`,
  }));

  const templateItems = templates.map((t) => ({
    value: String(t.id),
    label: t.name,
  }));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Default account (required for OFX/QFX)
          </label>
          <Combobox
            value={selectedAccountId}
            onValueChange={(v) => setSelectedAccountId(v ?? "")}
            items={accountItems}
            placeholder="— Use account column from CSV —"
            searchPlaceholder="Search…"
            emptyMessage="No accounts"
            className="w-full"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Settlement-vs-posting fuzz (days)
          </label>
          <input
            type="number"
            min={0}
            max={30}
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            CSV template (optional — for non-standard formats like IBKR)
          </label>
          <Combobox
            value={selectedTemplateId}
            onValueChange={(v) => setSelectedTemplateId(v ?? "")}
            items={templateItems}
            placeholder="— Auto-detect —"
            searchPlaceholder="Search templates…"
            emptyMessage={
              templates.length === 0
                ? "No saved templates yet"
                : "No matching templates"
            }
            className="w-full"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Statement balance (optional — CSV only)
          </label>
          <input
            type="number"
            step="0.01"
            value={statementBalance}
            onChange={(e) => setStatementBalance(e.target.value)}
            placeholder="e.g. 1234.56"
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          />
        </div>
      </div>

      <FileDropZone
        accept={ACCEPT}
        disabled={loading}
        onFileSelected={(file) => {
          const accountId = selectedAccountId ? Number(selectedAccountId) : null;
          const templateId = selectedTemplateId
            ? Number(selectedTemplateId)
            : null;
          const tol = Number.parseInt(tolerance, 10);
          // Only forward statementBalance if it parses as a finite number.
          // OFX/QFX statements provide their own balance, so the input is
          // really an aid for CSV uploads — server still accepts it for
          // OFX/QFX but the OFX balance takes priority when both are set.
          let bal: number | null = null;
          if (statementBalance.trim()) {
            const n = Number(statementBalance);
            if (!Number.isNaN(n) && Number.isFinite(n)) bal = n;
          }
          onUpload({
            file,
            accountId,
            tolerance: Number.isNaN(tol) ? 3 : Math.max(0, Math.min(30, tol)),
            templateId,
            statementBalance: bal,
          });
        }}
      />

      {loading && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading and classifying rows…
        </div>
      )}
    </div>
  );
}
