"use client";

/**
 * LensChip — the colored pill below the account row on /inbox.
 *
 * Click opens a dropdown of the three view lenses; each row shows whether
 * it's the persisted policy or just the current lens. A gear link at the
 * bottom routes to the per-account settings page where the policy itself
 * lives (lens flip is throwaway; policy is sticky). When `lens !== policy`
 * the chip grows a ring + glasses icon to telegraph "you're looking through
 * a different lens than this account's default".
 */

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ExternalLink,
  Glasses,
  Settings as SettingsIcon,
} from "lucide-react";
import { MODES, MODE_ORDER, type Mode } from "./modes";

export function LensChip({
  lens,
  policy,
  onLensChange,
  accountId,
  isInvestment = false,
}: {
  lens: Mode;
  policy: Mode;
  onLensChange: (m: Mode) => void;
  accountId: number;
  /** Investment accounts support Auto-pilot + Manual (FINLYNQ-208: rules now
   *  materialize lot-aware ops via `record_investment_op`). Approve-each stays
   *  disabled until its per-row commit flow is wired for investment (the
   *  /approve + /categorize routes still refuse investment accounts). */
  isInvestment?: boolean;
}) {
  const cfg = MODES[lens];
  const Icon = cfg.icon;
  const [open, setOpen] = useState(false);
  const isLensActive = lens !== policy;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${cfg.tone} ${
          isLensActive ? "ring-2 ring-offset-1 ring-offset-background" : ""
        }`}
      >
        {isLensActive ? (
          <Glasses className="h-3.5 w-3.5" />
        ) : (
          <Icon className="h-3.5 w-3.5" />
        )}
        {cfg.label}
        {isLensActive && (
          <span className="text-[9px] uppercase tracking-wider opacity-70">
            lens
          </span>
        )}
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full mt-2 z-30 w-[340px] rounded-lg border bg-popover shadow-xl p-1">
            <div className="px-2 py-2 border-b mb-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                View lens
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Temporarily see this account through a different gate model.
                Doesn&apos;t change the account&apos;s policy.
              </p>
            </div>
            {MODE_ORDER.map((m) => {
              const c = MODES[m];
              const I = c.icon;
              const isLens = m === lens;
              const isPolicy = m === policy;
              // Investment accounts: Auto-pilot + Manual work (rules record
              // lot-aware ops). Approve-each stays disabled until its per-row
              // commit flow is wired for investment.
              const disabled = isInvestment && m === "approve";
              return (
                <button
                  key={m}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    onLensChange(m);
                    setOpen(false);
                  }}
                  className={`w-full text-left p-2.5 rounded-md transition-colors ${
                    disabled
                      ? "opacity-40 cursor-not-allowed"
                      : isLens
                        ? "bg-muted"
                        : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <I className={`h-4 w-4 ${c.tone.split(" ")[0]}`} />
                    <span className="text-sm font-medium">{c.label}</span>
                    {disabled && (
                      <Badge
                        variant="outline"
                        className="ml-auto text-[10px] font-mono"
                      >
                        n/a
                      </Badge>
                    )}
                    {!disabled && isPolicy && (
                      <Badge
                        variant="outline"
                        className="ml-auto text-[10px] font-mono"
                      >
                        policy
                      </Badge>
                    )}
                    {!disabled && isLens && !isPolicy && (
                      <Badge
                        variant="outline"
                        className="ml-auto text-[10px] font-mono"
                      >
                        current lens
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 ml-6">
                    {disabled
                      ? "Approve-each isn't available for investment accounts yet — use Auto-pilot or Manual."
                      : c.subLabel}
                  </p>
                </button>
              );
            })}
            <div className="border-t mt-1 pt-2 pb-1 px-2">
              {/* Phase 5 (2026-05-27) — wired to the per-account detail page's
               *  Reconciliation mode card. `#reconciliation-mode` scrolls the
               *  user straight to the picker so the policy flip is one click
               *  away. Opens in the same tab to match the rest of the app's
               *  in-app navigation (Back arrow returns to /inbox). */}
              <Link
                href={`/accounts/${accountId}#reconciliation-mode`}
                onClick={() => setOpen(false)}
                className="w-full text-left inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
              >
                <SettingsIcon className="h-3.5 w-3.5" />
                Open account settings (to change the policy)
                <ExternalLink className="h-3 w-3 ml-auto" />
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
