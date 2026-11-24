"use client";

/**
 * A tag field that shows each finished tag as a chip and suggests the tags
 * already in use as you type (GH #449). A drop-in for the plain `<Input>`
 * every tag field used: the value is still ONE comma-separated string
 * ("a, b"), so nothing changes for the code that saves it.
 *
 * A tag is finished by a comma, Enter, picking a suggestion, or leaving the
 * field. Backspace in an empty box removes the last chip. Suggestions load
 * on first focus.
 */
import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTagOptions } from "@/lib/hooks/useTagOptions";
import {
  nearDuplicatesInValue,
  suggestTags,
  tagsInValue,
} from "@/lib/transactions/tag-suggest";

interface TagInputProps
  extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Hide the "close to an existing tag" note (tight rows). */
  hideNearDuplicateNote?: boolean;
}

const join = (tags: string[]) => tags.join(", ");

export function TagInput({
  value,
  onValueChange,
  className,
  placeholder,
  hideNearDuplicateNote,
  onFocus,
  onBlur,
  onKeyDown,
  disabled,
  ...props
}: TagInputProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);
  const [everFocused, setEverFocused] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  // The tag being typed. It is also the LAST tag of `value`, so a save that
  // happens mid-typing keeps it; when `value` changes from outside (a form
  // reset) the two stop matching and the draft is dropped.
  const [draftState, setDraftState] = React.useState("");
  const options = useTagOptions(everFocused);
  const listId = React.useId();

  const all = tagsInValue(value);
  const draftLive = draftState.trim() !== "" && all[all.length - 1] === draftState.trim();
  const draft = draftLive ? draftState : "";
  const chips = draftLive ? all.slice(0, -1) : all;

  const emit = (nextChips: string[], nextDraft: string) => {
    setDraftState(nextDraft);
    onValueChange(join(nextDraft.trim() ? [...nextChips, nextDraft.trim()] : nextChips));
  };

  // The rules read one comma-separated string whose last piece is in progress.
  const virtual = chips.length ? `${join(chips)}, ${draft}` : draft;
  const suggestions = React.useMemo(() => suggestTags(options, virtual), [options, virtual]);
  const open = focused && !dismissed && suggestions.length > 0;
  const near = hideNearDuplicateNote ? [] : nearDuplicatesInValue(options, join(chips));
  const nearSet = new Set(near.map((n) => n.typed));

  const pick = (tag: string) => {
    emit([...chips, tag], "");
    setActive(-1);
  };
  const removeChip = (i: number) => {
    emit(chips.filter((_, j) => j !== i), draft);
    // Keep the focus in the field so a save-on-blur caller still saves.
    inputRef.current?.focus();
  };

  return (
    <div className="relative">
      <div
        data-slot="tag-input"
        onMouseDown={(e) => {
          // A click on the box (not on a chip button or the text) focuses the text.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
        className={cn(
          "flex min-h-8 w-full min-w-0 cursor-text flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 text-base transition-colors md:text-sm dark:bg-input/30",
          focused && "border-ring ring-3 ring-ring/50",
          disabled && "pointer-events-none cursor-not-allowed bg-input/50 opacity-50",
          className,
        )}
      >
        {chips.map((tag, i) => (
          <span
            key={`${tag}-${i}`}
            data-slot="tag-chip"
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pl-2 pr-1 text-xs font-medium leading-4",
              nearSet.has(tag)
                ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                : "border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
            )}
          >
            <span className="truncate font-mono">{tag}</span>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Remove tag ${tag}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => removeChip(i)}
              className="rounded p-0.5 transition-colors hover:bg-sky-100 dark:hover:bg-sky-900"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          {...props}
          ref={inputRef}
          type="text"
          disabled={disabled}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          value={draft}
          placeholder={chips.length ? undefined : placeholder}
          className="h-5 min-w-16 flex-1 bg-transparent p-0 px-1 outline-none placeholder:text-muted-foreground"
          onChange={(e) => {
            setDismissed(false);
            setActive(-1);
            const text = e.target.value;
            if (text.includes(",")) {
              // A comma finishes the tag; pasted "a, b, c" becomes three chips
              // and whatever follows the last comma stays in progress.
              const parts = text.split(",");
              const rest = parts.pop() ?? "";
              emit([...chips, ...parts.map((p) => p.trim()).filter(Boolean)], rest.trimStart());
            } else {
              emit(chips, text);
            }
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
            // Leaving the field finishes the tag in progress (the value
            // already holds it, so only the chip display changes).
            setDraftState("");
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
            if (e.key === "Enter" && draft.trim()) {
              // Enter finishes the tag being typed instead of submitting.
              e.preventDefault();
              emit([...chips, draft.trim()], "");
              return;
            }
            if (e.key === "Backspace" && draft === "" && chips.length > 0) {
              e.preventDefault();
              emit(chips.slice(0, -1), "");
              return;
            }
            onKeyDown?.(e);
          }}
        />
      </div>
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
