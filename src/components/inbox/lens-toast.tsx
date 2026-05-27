"use client";

/**
 * LensToast — bottom-center toast on /inbox when `lens !== policy`.
 *
 * Three actions:
 *   - Revert       — snap lens back to the account's policy
 *   - Keep for now — dismiss the toast, leave lens as-is (session-local)
 *   - Save default — fire PATCH /api/accounts/[id]/mode with the lens value
 *                    so this lens becomes the account's persisted policy
 *
 * Save-as-default is the only path that mutates server state; the others
 * are purely view-local.
 */

import { Button } from "@/components/ui/button";
import { Glasses, Save } from "lucide-react";
import { MODES, type Mode } from "./modes";

export function LensToast({
  lens,
  accountLabel,
  onSave,
  onKeep,
  onRevert,
  saving,
}: {
  lens: Mode;
  accountLabel: string;
  onSave: () => void;
  onKeep: () => void;
  onRevert: () => void;
  saving?: boolean;
}) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 rounded-lg border bg-popover shadow-2xl px-4 py-3 flex items-center gap-3 max-w-[640px]">
      <Glasses className="h-4 w-4 text-foreground shrink-0" />
      <div className="text-xs">
        <p className="font-medium">
          Viewing <span className="font-mono">{accountLabel}</span> through{" "}
          <span className="font-mono">{MODES[lens].label}</span> lens
        </p>
        <p className="text-muted-foreground mt-0.5">
          Layout-only — rows already auto-applied stay reconciled. Save to
          change the account&apos;s policy too.
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onRevert}
          disabled={saving}
        >
          Revert
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onKeep}
          disabled={saving}
        >
          Keep for now
        </Button>
        <Button
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={onSave}
          disabled={saving}
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? "Saving…" : "Save as default"}
        </Button>
      </div>
    </div>
  );
}
