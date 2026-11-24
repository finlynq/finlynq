"use client";

/**
 * The Payee field: a plain text box that suggests payees already used as you
 * type. Typing a new payee works exactly as before; picking one also tells
 * the caller (`onPick`) so it can offer the category last used with it. Each
 * suggestion has a small button that takes it out of the list. Suggestions
 * load on first focus.
 */
import * as React from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { usePayeeOptions } from "@/lib/hooks/usePayeeOptions";
import { suggestPayees, type PayeeOption } from "@/lib/payees/suggest";

interface PayeeInputProps
  extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> {
  value: string;
  onValueChange: (value: string) => void;
  /** A suggestion was picked. Without it, picking just sets the text. */
  onPick?: (payee: PayeeOption) => void;
}

export function PayeeInput({
  value,
  onValueChange,
  onPick,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: PayeeInputProps) {
  const [focused, setFocused] = React.useState(false);
  const [everFocused, setEverFocused] = React.useState(false);
  // Suggestions show only after the user types, not for a value that was
  // already there when the field got the focus (an edit, a picked payee).
  const [typed, setTyped] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const { options, forget } = usePayeeOptions(everFocused);
  const listId = React.useId();

  const suggestions = React.useMemo(() => suggestPayees(options, value), [options, value]);
  const open = focused && typed && suggestions.length > 0;

  const pick = (p: PayeeOption) => {
    if (onPick) onPick(p);
    else onValueChange(p.name);
    setTyped(false);
    setActive(-1);
  };

  return (
    <div className="relative">
      <Input
        {...props}
        type="text"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        value={value}
        onChange={(e) => {
          setTyped(true);
          setActive(-1);
          onValueChange(e.target.value);
        }}
        onFocus={(e) => {
          setFocused(true);
          setEverFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          setTyped(false);
          setActive(-1);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % suggestions.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && active >= 0) {
              e.preventDefault();
              pick(suggestions[active]);
              return;
            }
            if (e.key === "Escape") {
              // Close the list only, not the dialog around the field.
              e.preventDefault();
              e.stopPropagation();
              setTyped(false);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1 max-h-64 w-max min-w-full max-w-[min(24rem,90vw)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.id}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: keep the focus in the field.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md py-1 pl-2 pr-1",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{s.count}</span>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Stop suggesting ${s.name}`}
                title="Stop suggesting this payee"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  forget(s.id);
                }}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
