"use client";

/**
 * TwoPaneLayout — side-by-side container for the FilePane (right) +
 * DbPane (left) on /import/pending (FINLYNQ-56).
 *
 * On wide viewports (lg+), both panes sit side-by-side with the DB pane
 * (existing transactions) on the left and the File pane (staged rows) on
 * the right — matching the user's mental model of "what I had → what
 * the bank sent." On narrow viewports the layout stacks (DB on top).
 *
 * The panes are equal-width columns; the parent owns each pane's
 * internal scroll. No content-clipping happens here — long lists scroll
 * within their pane to keep the action bar above the fold.
 */

import type { ReactNode } from "react";

export function TwoPaneLayout({
  leftLabel,
  left,
  rightLabel,
  right,
}: {
  leftLabel: ReactNode;
  left: ReactNode;
  rightLabel: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <section className="flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {leftLabel}
          </h2>
        </div>
        <div className="flex-1 min-h-0 border rounded-lg bg-card overflow-hidden">
          {left}
        </div>
      </section>
      <section className="flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {rightLabel}
          </h2>
        </div>
        <div className="flex-1 min-h-0 border rounded-lg bg-card overflow-hidden">
          {right}
        </div>
      </section>
    </div>
  );
}
