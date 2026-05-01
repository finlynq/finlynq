"use client";

/**
 * /settings/display — landing page that links to the existing
 * /settings/dropdown-order sub-page (issue #57).
 *
 * The dropdown-order page already inherits the new settings/layout.tsx,
 * so deep-linked users see the left nav.
 */

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Settings2 } from "lucide-react";

export default function DisplaySettingsPage() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Display & Ordering</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Customize how lists and pickers are ordered</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
                <Settings2 className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Dropdown Ordering</CardTitle>
                <CardDescription>Pin frequently-used items to the top of category, account, holding, and currency pickers</CardDescription>
              </div>
            </div>
            <Link href="/settings/dropdown-order">
              <Button variant="outline" size="sm">Open</Button>
            </Link>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}
