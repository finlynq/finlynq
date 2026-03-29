import * as React from "react";
import { cn } from "@/lib/utils";

interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  label?: string;
  error?: string;
}

export function DatePicker({ value, onChange, min, max, label, error }: DatePickerProps) {
  return (
    <div className="space-y-1">
      {label && (
        <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {label}
        </label>
      )}
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        className={cn(
          "h-8 w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30",
          error
            ? "border-destructive ring-3 ring-destructive/20"
            : "border-input"
        )}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
