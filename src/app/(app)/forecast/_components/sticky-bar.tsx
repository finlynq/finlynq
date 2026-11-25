"use client";

/**
 * A toolbar that stays at the top of the window once you scroll past it.
 *
 * CSS `position: sticky` can't do this here: the app shell's <main> has
 * `overflow: auto` (Transactions, Accounts, Reports and Portfolio rely on it to
 * scroll sideways on a phone), which makes <main> the sticky container even
 * though the window is what scrolls. So this pins the bar with `position:
 * fixed` while a placeholder keeps its space, matching the placeholder's left
 * edge and width (the sidebar can collapse; a ResizeObserver follows it).
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function StickyBar({ children, className }: { children: React.ReactNode; className?: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const [box, setBox] = useState<{ left: number; width: number; height: number }>({ left: 0, width: 0, height: 0 });

  useEffect(() => {
    const h = holder.current;
    const b = bar.current;
    if (!h || !b) return;
    const measure = () => {
      const r = h.getBoundingClientRect();
      setBox({ left: r.left, width: r.width, height: b.offsetHeight });
      setStuck(r.top < 0);
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(h);
    ro?.observe(b);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, []);

  return (
    <div ref={holder} style={stuck ? { height: box.height } : undefined}>
      <div
        ref={bar}
        data-stuck={stuck || undefined}
        className={cn(
          className,
          stuck && "fixed top-0 z-30 rounded-none border-x-0 border-t-0 bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/85",
        )}
        style={stuck ? { left: box.left, width: box.width } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
