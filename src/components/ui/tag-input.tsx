"use client";

/**
 * A comma-separated tag field that suggests the tags already in use as you
 * type (GH #449). A drop-in for the plain `<Input>` every tag field used:
 * the value is still one comma-separated string, and typing a new tag works
 * exactly as before. Suggestions load on first focus.
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTagOptions } from "@/lib/hooks/useTagOptions";
import {
  applyTagSuggestion,
  nearDuplicatesInValue,
  suggestTags,
} from "@/lib/transactions/tag-suggest";

interface TagInputProps
  extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Hide the "close to an existing tag" note (tight rows). */
  hideNearDuplicateNote?: boolean;
}

export function TagInput({
  value,
  onValueChange,
  className,
  hideNearDuplicateNote,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: TagInputProps) {
  const [focused, setFocused] = React.useState(false);
  const [everFocused, setEverFocused] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const options = useTagOptions(everFocused);
  const listId = React.useId();

  const suggestions = React.useMemo(() => suggestTags(options, value), [options, value]);
  const open = focused && !dismissed && suggestions.length > 0;
  const near = React.useMemo(
    () => {
      if (hideNearDuplicateNote) return [];
      // While typing, judge only the finished tags, not the one in progress.
      const i = value.lastIndexOf(",");
      const settled = focused ? (i === -1 ? "" : value.slice(0, i)) : value;
      return nearDuplicatesInValue(options, settled);
    },
    [options, value, hideNearDuplicateNote, focused],
  );

  const pick = (tag: string) => {
    onValueChange(applyTagSuggestion(value, tag));
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
        className={className}
        onChange={(e) => {
          setDismissed(false);
          setActive(-1);
          onValueChange(e.target.value);
        }}
        onFocus={(e) => {
          setFocused(true);
          setEverFocused(true);
          setDismissed(false);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
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
              pick(suggestions[active].tag);
              return;
            }
            if (e.key === "Escape") {
              // Close the list only, not the dialog around the field.
              e.preventDefault();
              e.stopPropagation();
              setDismissed(true);
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
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 min-w-40 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.tag}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: keep the focus in the field.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s.tag);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <span className="truncate">{s.tag}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{s.count}</span>
            </li>
          ))}
        </ul>
      )}
      {near.length > 0 && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {near.map((n, i) => (
            <span key={n.typed}>
              {i > 0 && " "}
              &ldquo;{n.typed}&rdquo; is close to your tag &ldquo;{n.existing}&rdquo;.
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
