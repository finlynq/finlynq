"use client";

/**
 * FINLYNQ-301 — generic decision-prompt gate.
 *
 * Mounted app-wide in `(app)/layout.tsx` INSIDE `UnlockGate` (Don't rules #6/#9)
 * so it fires on any authed page, never on a single one, and never blocks the
 * DEK-unlock or login flow. Fetches the user's pending prompts, renders them
 * one at a time in a dialog, and advances through the queue in-session without
 * a reload.
 *
 * State is server-side (`user_prompt_acks`), never localStorage (Don't rule #2):
 * "Not now" POSTs `/defer` (a cross-device cooldown), a submit POSTs `/answer`.
 * A failing `GET /api/prompts/pending` renders nothing rather than an error
 * state (Don't rule #9).
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PROMPT_FORMS, type PromptView } from "@/components/prompts/prompt-forms";

interface PendingResponse {
  success?: boolean;
  data?: { prompts?: PromptView[] };
}

export function PromptGate() {
  const [queue, setQueue] = useState<PromptView[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/prompts/pending")
      .then((r) => (r.ok ? r.json() : null))
      .then((json: PendingResponse | null) => {
        if (cancelled || !json?.data?.prompts) return;
        // Only queue prompts we actually have a form for — never render a
        // dialog the surface can't fill.
        setQueue(json.data.prompts.filter((p) => PROMPT_FORMS[p.id]));
      })
      .catch(() => {
        /* Don't rule #9 — render nothing on failure, never an error state. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = queue[0];
  const Form = current ? PROMPT_FORMS[current.id] : undefined;

  /** Drop the head of the queue and clear per-prompt transient state. */
  const advance = () => {
    setError(null);
    setSubmitting(false);
    setQueue((q) => q.slice(1));
  };

  const handleSubmit = async (answer: unknown) => {
    if (!current || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/prompts/${current.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: current.version, answer }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }
      advance();
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  };

  const handleDefer = () => {
    if (!current || !current.deferrable || submitting) return;
    // Optimistic: advance immediately; the cooldown write is fire-and-forget.
    const { id, version } = current;
    advance();
    fetch(`/api/prompts/${id}/defer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    }).catch(() => {});
  };

  if (!current || !Form) return null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (next) return;
        // Dismiss (X / Esc / backdrop) counts as "Not now" for deferrable
        // prompts; non-deferrable prompts can't be dismissed this way.
        if (current.deferrable) handleDefer();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{current.title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{current.body}</p>
        <Form
          prompt={current}
          submitting={submitting}
          error={error}
          onSubmit={handleSubmit}
        />
        {current.deferrable && (
          <div className="mt-1 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={handleDefer}
            >
              Not now
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
