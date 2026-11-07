"use client";

/**
 * A Reports date field that only passes on a finished date (2026-11-07).
 *
 * A browser date input fires `change` for every keystroke of the year, so
 * typing "2010" reports 0002-01-01, 0020-01-01 and 0201-01-01 first. Each of
 * those went straight into the report fetches, and the income statement priced
 * every holding at year 2: about 80 refused Yahoo calls per keystroke, which
 * then blocked live prices for every user for 10 minutes.
 *
 * The field keeps what is being typed as its own draft and calls `onCommit`
 * only when the draft is a date a report can run for (`isReportDate`). Leaving
 * the field with an unfinished date puts the last committed one back. A new
 * `value` from outside (a preset) replaces the draft, adjusted during render
 * rather than in an effect.
 */

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { isReportDate } from "@/lib/reports/period";

export function ReportDateInput({
  value,
  onCommit,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onCommit: (date: string) => void;
  className?: string;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setDraft(value);
  }

  return (
    <Input
      type="date"
      value={draft}
      aria-label={ariaLabel}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (isReportDate(next) && next !== value) onCommit(next);
      }}
      onBlur={() => {
        if (!isReportDate(draft)) setDraft(value);
      }}
      className={className}
    />
  );
}
