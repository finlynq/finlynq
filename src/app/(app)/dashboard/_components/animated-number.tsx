"use client";

import { useEffect, useRef } from "react";
import { animate } from "framer-motion";
import { formatCurrency } from "@/lib/currency";

export function AnimatedNumber({ value, currency = "CAD" }: { value: number; currency?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const controls = animate(0, value, {
      duration: 1.2,
      ease: "easeOut",
      onUpdate(latest) {
        node.textContent = formatCurrency(latest, currency);
      },
    });

    return () => controls.stop();
  }, [value, currency]);

  return <span ref={ref}>{formatCurrency(0, currency)}</span>;
}
