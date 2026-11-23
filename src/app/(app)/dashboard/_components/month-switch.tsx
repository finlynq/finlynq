"use client";

import { useCallback, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SPEND_MONTH_STORAGE_KEY,
  parseSpendMonthMode,
  type SpendMonthMode,
} from "@/lib/dashboard/spend-month";

function readStoredMode(storageKey: string): SpendMonthMode {
  try {
    return parseSpendMonthMode(window.localStorage.getItem(storageKey));
  } catch {
    return "last";
  }
}

/**
 * GH #447: the month one dashboard card shows (last complete month or this
 * month so far). Each card has its own storageKey, so each switches on its own
 * and remembers its choice in this browser.
 */
export function useSpendMonthMode(storageKey: string = SPEND_MONTH_STORAGE_KEY): [SpendMonthMode, () => void] {
  const [mode, setMode] = useState<SpendMonthMode>(() => readStoredMode(storageKey));
  const toggle = useCallback(() => {
    setMode((prev) => {
      const next: SpendMonthMode = prev === "current" ? "last" : "current";
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Storage blocked: the choice still applies until the page reloads.
      }
      return next;
    });
  }, [storageKey]);
  return [mode, toggle];
}

/** Small switch icon with the month shown written next to it. */
export function MonthSwitch({ showingCurrent, onToggle }: { showingCurrent: boolean; onToggle: () => void }) {
  const switchLabel = showingCurrent ? "Show last month" : "Show this month";
  return (
    <div className="flex items-center gap-1">
      <Button
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground hover:text-foreground"
        aria-label={switchLabel}
        title={switchLabel}
        onClick={onToggle}
      >
        <ArrowLeftRight />
      </Button>
      <span className="text-[11px] font-medium text-muted-foreground" data-testid="spend-month-shown">
        {showingCurrent ? "This month" : "Last month"}
      </span>
    </div>
  );
}
