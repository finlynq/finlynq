/**
 * Why a forecast line is blank, in words the user can act on (GH #463).
 * Pure and browser-safe.
 *
 * A line is blank when no layer gave it an amount in any forecast month. The
 * forecast starts NEXT month, so a budget typed for this month alone is never
 * used, and a History layer leaves a line blank when it had no spending in the
 * complete months it looks back over. The banner used to say "no budget" in
 * every case and link to this month's budgets, a path that could not clear it.
 */
import type { ScenarioConfig } from "./config";
import type { ForecastInputs } from "./types";
import { shiftMonth } from "./layers";

export type BlankLine = { key: string; label: string; type: string };

export type BlankExplanation = {
  /** First forecast month (next month). */
  startMonth: string;
  /** The month before the forecast (this month). */
  currentMonth: string;
  /** Blank lines that have a budget for this month only. */
  thisMonthOnly: string[];
  /** Months the enabled History layer looks back over; null when none is on. */
  historyLookback: number | null;
};

export function explainBlankLines(
  blank: readonly BlankLine[],
  inputs: Pick<ForecastInputs, "startMonth" | "currentMonthBudget" | "historyMonths">,
  config: Pick<ScenarioConfig, "layers">,
): BlankExplanation {
  const current = inputs.currentMonthBudget ?? {};
  const history = config.layers.find((l) => l.kind === "history" && l.enabled);
  const available = inputs.historyMonths?.length ?? 0;
  return {
    startMonth: inputs.startMonth,
    currentMonth: shiftMonth(inputs.startMonth, -1),
    thisMonthOnly: blank.filter((b) => current[b.key] != null).map((b) => b.label),
    historyLookback:
      history && history.kind === "history" ? Math.min(history.params.lookbackMonths, available || history.params.lookbackMonths) : null,
  };
}

/**
 * Dismissing the Forecast notes strip (GH #469). The X hides the WHOLE strip:
 * the blank-lines note and every other note in it (warnings, lines left out).
 * Each note has a key; dismissing remembers the keys shown, and the strip
 * comes back as soon as a key appears that was not dismissed (a new blank
 * line, a new warning, a warning whose wording changed), so new information
 * is never hidden by an old dismissal. Stored in this browser only.
 */
export const FORECAST_NOTES_DISMISSED_KEY = "pf-forecast-notes-dismissed";

/** Every key the strip would show now: blank lines (`blank:<line key>`) plus each note's key. */
export function forecastNoteKeys(
  blank: readonly Pick<BlankLine, "key">[],
  notes: readonly { key: string }[],
): string[] {
  return [...new Set([...blank.map((b) => `blank:${b.key}`), ...notes.map((n) => n.key)])].sort();
}

/** Hidden while there is something to show and all of it was dismissed. */
export function areNotesDismissed(keys: readonly string[], dismissedKeys: readonly string[]): boolean {
  if (keys.length === 0) return false;
  const dismissed = new Set(dismissedKeys);
  return keys.every((k) => dismissed.has(k));
}

/** Read the stored keys; anything unreadable counts as nothing dismissed. */
export function parseDismissedKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}
