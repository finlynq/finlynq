"use client";

/**
 * /settings/investments — landing page that links to the existing
 * /settings/holding-accounts sub-page (issue #57).
 *
 * The holding-accounts page already inherits the new settings/layout.tsx,
 * so deep-linked users see the left nav. This landing page just gives the
 * group its own discoverable home.
 */

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Briefcase } from "lucide-react";

export default function InvestmentsSettingsPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Investments</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Investment-related settings</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600">
                <Briefcase className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Holding ↔ Account Map</CardTitle>
                <CardDescription>Track the same security across multiple accounts with per-pairing qty + cost basis</CardDescription>
              </div>
            </div>
            <Link href="/settings/holding-accounts">
              <Button variant="outline" size="sm">Open</Button>
            </Link>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}
