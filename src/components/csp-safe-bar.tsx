"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * CSP-safe progress / gauge bar (FINLYNQ-83).
 *
 * Renders a thin horizontal bar with a colored fill whose width is set via
 * `element.style.setProperty()` in a `useEffect` AFTER the browser has
 * evaluated CSP on the HTML. CSP only inspects HTML-rendered `style="..."`
 * attributes, not JS-set element.style mutations.
 *
 * Use this in place of:
 *   <div className="..." style={{ width: `${pct}%` }} />
 *
 * For ABSOLUTE positioning of overlays / pop-overs from a computed coord,
 * write the ref-callback inline at the call site (see SankeyChart's tooltip).
 */

type Props = {
  /** Percentage 0-100. Negative clamps to 0; >100 clamps to 100. */
  percent: number;
  /** Tailwind classes for the fill element (color, transition, rounded, etc.). */
  fillClassName?: string;
  /** Tailwind classes for the outer track. */
  className?: string;
  /** Optional aria-label for accessibility. */
  ariaLabel?: string;
};

export function CspSafeBar({ percent, fillClassName, className, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const clamped = Math.max(0, Math.min(100, percent));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = `${clamped}%`;
  }, [clamped]);

  return (
    <div
      className={cn("relative h-2.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role={ariaLabel ? "progressbar" : undefined}
      aria-label={ariaLabel}
      aria-valuenow={ariaLabel ? clamped : undefined}
      aria-valuemin={ariaLabel ? 0 : undefined}
      aria-valuemax={ariaLabel ? 100 : undefined}
    >
      <div
        ref={ref}
        className={cn("h-full rounded-full bg-primary transition-all", fillClassName)}
      />
    </div>
  );
}

/**
 * Small color dot whose background is set via ref-callback so the rendered
 * HTML carries NO `style="..."` attribute. (FINLYNQ-83)
 */
export function ColorDot({
  color,
  className,
}: {
  color: string;
  className?: string;
}) {
  return (
    <div
      className={cn("h-2 w-2 rounded-full shrink-0", className)}
      ref={(el) => {
        if (el) el.style.background = color;
      }}
    />
  );
}

/**
 * CSP-safe variant of CspSafeBar with a per-instance background color
 * (instead of a Tailwind class). Width + background set via ref-callback.
 * (FINLYNQ-83)
 */
export function CspSafeColorBar({
  percent,
  color,
  className,
}: {
  percent: number;
  color: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const clamped = Math.max(0, Math.min(100, percent));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = `${clamped}%`;
    el.style.background = color;
  }, [clamped, color]);

  return (
    <div className={cn("h-full w-full overflow-hidden rounded-full bg-muted", className)}>
      <div ref={ref} className="h-full rounded-full" />
    </div>
  );
}
