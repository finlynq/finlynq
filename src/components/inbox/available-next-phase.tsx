"use client";

/**
 * AvailableNextPhase — placeholder body for Auto / Approve lens tabs.
 *
 * Phase 2 of the Reconcile v4 plan ships only the Manual-lens content;
 * Auto-pilot (Phase 4) and Approve-each (Phase 3) cards land later. The
 * tabs themselves render so the lens-chip morphing and the lens-toast
 * "Save as default" flow are exercisable end-to-end.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Sparkles } from "lucide-react";

export function AvailableNextPhase({
  phase,
  feature,
}: {
  phase: "Phase 3" | "Phase 4";
  feature: string;
}) {
  return (
    <Card>
      <CardContent className="py-12 text-center space-y-3">
        <Sparkles className="h-10 w-10 text-muted-foreground mx-auto" />
        <div>
          <p className="text-sm font-medium">Available next phase — {phase}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            {feature} ships in {phase} of the Reconcile v4 rollout. Switch the
            lens chip back to Manual to use the two-pane surface meanwhile,
            or change the account&apos;s policy via the gear in the chip.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
