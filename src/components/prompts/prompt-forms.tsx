"use client";

/**
 * FINLYNQ-301 — client id→form map for the decision-prompt gate.
 *
 * Deliberately SEPARATE from the server-side prompt registry (the module under
 * src/lib/prompts/ that reaches `db`). Never import that server registry into a
 * client component — it drags `pg`/`dns` into the browser bundle (Don't rule
 * #1); the CI bundle guard greps client dirs for that import path. This module holds
 * only the presentational half: each prompt id maps to a small form component
 * that collects an answer and hands it back via `onSubmit`.
 *
 * How to add a prompt's form: docs/user-prompts.md.
 */

import { type ComponentType, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SUPPORTED_FIAT_CURRENCIES,
  currencyLabel,
} from "@/lib/fx/supported-currencies";

/** The pending-prompt shape the gate hands each form (from GET /api/prompts/pending). */
export interface PromptView {
  id: string;
  version: number;
  title: string;
  body: string;
  deferrable: boolean;
  deferCount: number;
}

export interface PromptFormProps {
  prompt: PromptView;
  /** True while an answer submit is in flight — disable inputs + the submit. */
  submitting: boolean;
  /** Server error from the last failed submit, or null. */
  error: string | null;
  /** Hand the collected answer back to the gate, which POSTs it. */
  onSubmit: (answer: unknown) => void;
}

/**
 * FINLYNQ-301 phase 4 — display-currency form. A single currency Select seeded
 * to USD. Submits `{ currency }`, which the server
 * `displayCurrencyPrompt.answerSchema` validates.
 *
 * Options come from `SUPPORTED_FIAT_CURRENCIES`, mirroring the Display Currency
 * picker on `/settings/general` — deliberately NOT `useActiveCurrencies`. #291
 * scopes RECORD currency pickers (account / transaction / holding / goal) to the
 * user's active set; the display currency is the app-wide REPORTING choice and
 * the active set is derived FROM it, so scoping this picker to it is circular.
 * For a user with no `display_currency` row — the only user this prompt asks —
 * that derivation collapsed to the default plus the seed, and the dropdown
 * offered literally two options.
 */
function DisplayCurrencyForm({ submitting, error, onSubmit }: PromptFormProps) {
  const [currency, setCurrency] = useState("USD");

  return (
    <div className="mt-2 space-y-3">
      <Select
        value={currency}
        onValueChange={(v) => setCurrency(v || "USD")}
        disabled={submitting}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_FIAT_CURRENCIES.map((c) => (
            <SelectItem key={c} value={c}>
              {c} — {currencyLabel(c)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button
        className="w-full"
        disabled={submitting}
        onClick={() => onSubmit({ currency })}
      >
        {submitting ? "Saving…" : "Save currency"}
      </Button>
    </div>
  );
}

/**
 * Prompt id → form component. A pending prompt with no entry here is skipped by
 * the gate, so the surface never renders a dialog it can't fill.
 */
export const PROMPT_FORMS: Record<string, ComponentType<PromptFormProps>> = {
  display_currency: DisplayCurrencyForm,
};
