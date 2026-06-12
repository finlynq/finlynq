"use client";

/**
 * ConfirmDialog — shared destructive-confirmation modal (FINLYNQ-142).
 *
 * A small wrapper over the base-ui `<Dialog>` that mirrors the styling of
 * the transactions delete dialog (`AlertTriangle` + destructive title,
 * outline Cancel / destructive Confirm footer). Use it to gate permanent
 * deletes behind an explicit confirm step.
 *
 * Controlled: the parent owns `open` and the `onConfirm` side-effect. The
 * dialog stays open while `busy` (a delete fetch in flight) so a slow or
 * failed delete cannot be dismissed mid-flight; the parent flips `open`
 * to false once the delete resolves.
 *
 * base-ui constraints: render-prop (never `asChild`); footer buttons use
 * the shared <Button> variants.
 */

import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Heading text (e.g. "Delete goal"). */
  title: string;
  /** Body copy explaining what will happen. Plain string or rich node. */
  description: React.ReactNode;
  /** Confirm button label. Defaults to "Delete". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Fired when the destructive action is confirmed. */
  onConfirm: () => void;
  /** True while the confirmed action is in flight — disables buttons,
   *  swaps the confirm label to a busy label, and blocks dismissal. */
  busy?: boolean;
  /** Busy label shown on the confirm button. Defaults to "Deleting…". */
  busyLabel?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  busy = false,
  busyLabel = "Deleting…",
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't allow dismissal while the destructive action is running.
        if (busy && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="text-sm text-muted-foreground">{description}</div>
        <div className="flex gap-2 mt-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            variant="destructive"
            className="flex-1"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
