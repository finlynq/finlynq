"use client";

/**
 * FINLYNQ-301 — client id→form map for the decision-prompt gate.
 *
 * Deliberately SEPARATE from the server registry (`src/lib/prompts/registry.ts`,
 * which reaches `db`). Never import that registry into a client component — it
 * drags `pg`/`dns` into the browser bundle (Don't rule #1). This module holds
 * only the presentational half: each prompt id maps to a small form component
 * that collects an answer and hands it back via `onSubmit`.
 *
 * How to add a prompt's form: docs/user-prompts.md.
 */

import type { ComponentType } from "react";

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
 * Prompt id → form component. Empty until a consumer registers one (the
 * display-currency form lands with its prompt in phase 4). A pending prompt
 * with no entry here is skipped by the gate, so the surface never renders a
 * dialog it can't fill.
 */
export const PROMPT_FORMS: Record<string, ComponentType<PromptFormProps>> = {};
