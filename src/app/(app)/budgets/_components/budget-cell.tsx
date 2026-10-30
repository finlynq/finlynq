"use client";

import { useEffect, useRef, useState } from "react";
import { formatCurrency } from "@/lib/currency";

/**
 * A budget amount you click to edit. Enter or leaving the field saves, Escape
 * cancels, an empty field clears the budget. While empty it shows a hint (the
 * 3-month average) so you can see what to type.
 */
export function BudgetCell({
  value,
  currency,
  hint,
  disabled,
  onSave,
  label,
}: {
  value: number | null;
  currency: string;
  hint?: number | null;
  disabled?: boolean;
  onSave: (amount: number | null) => Promise<void>;
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function start() {
    if (disabled || busy) return;
    setText(value == null ? "" : String(value));
    setError("");
    setEditing(true);
  }

  async function commit() {
    const trimmed = text.trim();
    const next = trimmed === "" ? null : Number(trimmed.replace(/,/g, ""));
    if (next != null && (!Number.isFinite(next) || next < 0)) {
      setError("Enter 0 or more");
      return;
    }
    setEditing(false);
    if (next === value || (next != null && value != null && Math.abs(next - value) < 0.005)) return;
    setBusy(true);
    try {
      await onSave(next);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label={label}
        inputMode="decimal"
        className="h-7 w-full rounded-md border border-primary bg-background px-2 text-right font-mono text-xs tabular-nums outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={disabled}
      aria-label={label}
      title={error || (disabled ? undefined : "Click to edit")}
      className={`h-7 w-full rounded-md border px-2 text-right font-mono text-xs tabular-nums transition-colors ${
        disabled
          ? "cursor-default border-transparent text-muted-foreground"
          : value == null
            ? "border-dashed border-border text-muted-foreground hover:border-primary hover:text-foreground"
            : "border-transparent bg-muted/60 hover:border-primary hover:bg-transparent"
      } ${error ? "border-rose-500" : ""} ${busy ? "opacity-50" : ""}`}
    >
      {value != null
        ? formatCurrency(value, currency)
        : hint && hint > 0
          ? `avg ${formatCurrency(hint, currency, { decimals: 0 })}`
          : "—"}
    </button>
  );
}
