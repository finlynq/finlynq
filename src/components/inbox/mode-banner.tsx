"use client";

/**
 * ModeBanner — small inline strip below the account header on /inbox.
 *
 * Explains what the current LENS implies for the visible workflow. When
 * lens !== policy, appends a "Policy is X" note so the user remembers the
 * sticky setting they're temporarily overriding.
 */

import { Info } from "lucide-react";
import { MODES, type Mode } from "./modes";

export function ModeBanner({
  lens,
  policy,
}: {
  lens: Mode;
  policy: Mode;
}) {
  const cfg = MODES[lens];
  const isLensActive = lens !== policy;
  return (
    <div
      className={`rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${cfg.tone}`}
    >
      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <div>
        <span className="font-medium">{cfg.label}</span> · {cfg.subLabel}
        {isLensActive && (
          <>
            {" · "}
            <span className="font-medium">
              Policy is {MODES[policy].label}.
            </span>
          </>
        )}
      </div>
    </div>
  );
}
