"use client";

import { useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import { FileDropZone } from "@/app/(app)/import/components/file-drop-zone";
import { Loader2 } from "lucide-react";

import type { AccountOption } from "./preview-table";

interface Props {
  accounts: AccountOption[];
  loading: boolean;
  onUpload: (params: { file: File; accountId: number | null; tolerance: number }) => void;
}

const ACCEPT = ".csv,.ofx,.qfx";

export function ReconcileUploadCard({ accounts, loading, onUpload }: Props) {
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [tolerance, setTolerance] = useState<string>("3");

  const accountItems = accounts.map((a) => ({
    value: String(a.id),
    label: `${a.name} (${a.currency})`,
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

      <FileDropZone
        accept={ACCEPT}
        disabled={loading}
        onFileSelected={(file) => {
          const accountId = selectedAccountId ? Number(selectedAccountId) : null;
          const tol = Number.parseInt(tolerance, 10);
          onUpload({
            file,
            accountId,
            tolerance: Number.isNaN(tol) ? 3 : Math.max(0, Math.min(30, tol)),
          });
        }}
      />

      {loading && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Classifying rows against existing transactions…
        </div>
      )}
    </div>
  );
}
