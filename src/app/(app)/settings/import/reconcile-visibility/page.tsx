"use client";

/**
 * /settings/import/reconcile-visibility — per-account "hide from reconcile
 * dropdown" management. Renders the full ReconcileHideAccountsCard list UI
 * (fetch + optimistic toggle) so the main /settings/import page can show a
 * compact entry-point card instead of the full list inline.
 *
 * FINLYNQ-241 — collapsed the inline list on /settings/import behind this
 * subpage. Persistence is unchanged: GET/PUT /api/settings/reconcile-hidden-accounts.
 */

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { ReconcileHideAccountsCard } from "@/components/inbox/reconcile-hide-accounts-card";

export default function ReconcileVisibilityPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link
          href="/settings/import"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3"
        >
          <ChevronLeft className="h-4 w-4" />
          Import settings
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Reconcile dropdown visibility</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Choose which accounts appear in the account picker on the Import page.
        </p>
      </div>

      <ReconcileHideAccountsCard />
    </div>
  );
}
