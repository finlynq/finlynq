"use client";

/**
 * UploadDrawer — account-pre-scoped right-side drawer triggered from the
 * /inbox header.
 *
 * Phase 2 ships the surface + after-upload bullet copy per policy, with
 * the actual upload UI hosted at /import (the existing file-picker + CSV
 * parser surface). A primary CTA opens /import?accountId=<id> so the user
 * lands on the picker with the account preselected.
 *
 * Phase 3+ may inline a drop-zone here once the upload pipeline becomes
 * account-aware per mode; for now /import handles every format.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Upload, X } from "lucide-react";
import { MODES, type Mode } from "./modes";

interface AfterUploadBullet {
  body: React.ReactNode;
}

function bulletsForPolicy(policy: Mode): AfterUploadBullet[] {
  if (policy === "auto") {
    return [
      {
        body: (
          <>
            Matched rules →{" "}
            <span className="font-medium text-foreground">Reconciled</span>
          </>
        ),
      },
      {
        body: (
          <>
            Unmatched →{" "}
            <span className="font-medium text-foreground">To categorize</span>
          </>
        ),
      },
    ];
  }
  if (policy === "approve") {
    return [
      {
        body: (
          <>
            Rows land in{" "}
            <span className="font-medium text-foreground">To approve</span>{" "}
            with suggestions
          </>
        ),
      },
    ];
  }
  return [
    {
      body: (
        <>
          Rows land in{" "}
          <span className="font-medium text-foreground">Staging</span>{" "}
          two-pane for parse review
        </>
      ),
    },
    {
      body: (
        <>
          Approved rows move to{" "}
          <span className="font-medium text-foreground">Reconcile</span>{" "}
          two-pane
        </>
      ),
    },
  ];
}

export function UploadDrawer({
  open,
  onOpenChange,
  accountId,
  accountLabel,
  policy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: number;
  accountLabel: string;
  policy: Mode;
}) {
  const router = useRouter();
  const cfg = MODES[policy];
  const bullets = bulletsForPolicy(policy);

  // ESC closes the drawer — matches the standard sheet/dialog interaction
  // shipped via shadcn/ui throughout the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <div className="fixed right-0 top-0 z-50 h-full w-full max-w-md border-l bg-background shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">
              Upload to {accountLabel}
            </h2>
            <p className="text-xs text-muted-foreground">
              Policy: {cfg.label} · {cfg.gates} gate
              {cfg.gates !== 1 ? "s" : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => onOpenChange(false)}
            aria-label="Close upload drawer"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-5 space-y-5 flex-1 overflow-y-auto">
          <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/20 px-6 py-10 text-center">
            <Upload className="mx-auto h-7 w-7 text-muted-foreground/60" />
            <p className="mt-2 text-sm font-medium">Upload a statement</p>
            <p className="text-xs text-muted-foreground">
              CSV · OFX · QFX · XML
            </p>
            <p className="text-xs text-muted-foreground mt-3 max-w-xs mx-auto">
              The full upload surface lives on the Import page. Click below to
              open it with this account pre-selected.
            </p>
          </div>
          <div className={`rounded-md border px-3 py-2.5 text-xs ${cfg.tone}`}>
            <p className="font-medium">
              After upload — {cfg.label}:
            </p>
            <ul className="mt-1.5 space-y-0.5 text-muted-foreground list-disc pl-4">
              {bullets.map((b, i) => (
                <li key={i}>{b.body}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="border-t bg-background px-5 py-3 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              router.push(`/import?accountId=${accountId}`);
              onOpenChange(false);
            }}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Open Import
          </Button>
        </div>
      </div>
    </>
  );
}
