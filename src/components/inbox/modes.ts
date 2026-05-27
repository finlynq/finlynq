/**
 * Shared mode metadata for the account-anchored /inbox surface
 * (Reconcile v4 — plan/reconcile-v4-account-anchored-inbox.md).
 *
 * Three policies / lenses:
 *   'auto'    — Auto-pilot: 0 gates, rules fire at upload → ledger.
 *   'approve' — Approve-each: 1 gate, one-click ledger commit per row.
 *   'manual'  — Manual review: 2 gates, the existing two-pane experience.
 *
 * `policy` = what's persisted on `accounts.mode`. `lens` = the user's
 * throwaway view-only override. They're the same shape; UI uses both.
 */

import { Zap, ShieldCheck, Eye, type LucideIcon } from "lucide-react";

export type Mode = "auto" | "approve" | "manual";

export interface ModeMeta {
  label: string;
  subLabel: string;
  icon: LucideIcon;
  gates: number;
  /** Tailwind class set for the chip / banner background tint. */
  tone: string;
}

export const MODES: Record<Mode, ModeMeta> = {
  auto: {
    label: "Auto-pilot",
    subLabel: "File → ledger. Rules auto-categorize.",
    icon: Zap,
    gates: 0,
    tone: "text-emerald-500 bg-emerald-500/10 border-emerald-500/30",
  },
  approve: {
    label: "Approve-each",
    subLabel: "File → bank. You approve each ledger entry.",
    icon: ShieldCheck,
    gates: 1,
    tone: "text-sky-500 bg-sky-500/10 border-sky-500/30",
  },
  manual: {
    label: "Manual review",
    subLabel:
      "Two gates. Staging two-pane, then bank-vs-transactions two-pane.",
    icon: Eye,
    gates: 2,
    tone: "text-amber-500 bg-amber-500/10 border-amber-500/30",
  },
};

export function isMode(v: unknown): v is Mode {
  return v === "auto" || v === "approve" || v === "manual";
}

export const MODE_ORDER: Mode[] = ["auto", "approve", "manual"];
