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
import { Combobox } from "@/components/ui/combobox";
import { useDisplayCurrencyOptions } from "@/lib/hooks/useDisplayCurrencyOptions";

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
 * FINLYNQ-301 phase 4 — display-currency form. A searchable currency Combobox
 * seeded to USD. Submits `{ currency }`, which the server
 * `displayCurrencyPrompt.answerSchema` validates.
 *
 * Options come from the shared `useDisplayCurrencyOptions` — the same list the
 * onboarding wizard and Settings → General use, and deliberately NOT
 * `useActiveCurrencies` (see that hook's header for why scoping this picker to
 * the active set is circular; it collapsed to two options for exactly the
 * rowless users this prompt targets).
 */
function DisplayCurrencyForm({ submitting, error, onSubmit }: PromptFormProps) {
  const [currency, setCurrency] = useState("USD");
  const options = useDisplayCurrencyOptions(currency);

  return (
    <div className="mt-2 space-y-3">
      <Combobox
        value={currency}
        onValueChange={(v) => setCurrency(v || "USD")}
        items={options}
        disabled={submitting}
        placeholder="Select currency"
        searchPlaceholder="Search currencies…"
        emptyMessage="No matching currency"
      />
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
