"use client"

/**
 * Combobox — type-ahead-filterable single-select dropdown.
 *
 * Visually matches `<Select>` (same Tailwind tokens, same trigger metrics).
 * Built on `@base-ui/react/combobox` (single-selection mode). Filtering is
 * automatic when `items` are passed.
 *
 * Two ways to use:
 *
 *   1) High-level (recommended for migrations from <Select>):
 *
 *        <Combobox
 *          value={form.categoryId}
 *          onValueChange={(v) => setForm({ ...form, categoryId: v ?? "" })}
 *          items={categories.map((c) => ({ value: String(c.id), label: `${c.group} / ${c.name}` }))}
 *          placeholder="Select category"
 *          searchPlaceholder="Search categories…"
 *          emptyMessage="No categories"
 *        />
 *
 *   2) Low-level (for grouped lists / custom rendering):
 *
 *        <ComboboxRoot value={...} onValueChange={...} items={items}>
 *          <ComboboxTrigger>
 *            <ComboboxValue placeholder="…" />
 *          </ComboboxTrigger>
 *          <ComboboxContent>
 *            <ComboboxInput />
 *            <ComboboxList>
 *              <ComboboxEmpty>No matches</ComboboxEmpty>
 *              {items.map((item) => (
 *                <ComboboxItem key={item.value} value={item.value}>{item.label}</ComboboxItem>
 *              ))}
 *            </ComboboxList>
 *          </ComboboxContent>
 *        </ComboboxRoot>
 *
 * CLAUDE.md "Select Components" rule: base-ui's `onValueChange` may pass `null`.
 * The high-level wrapper coerces to `string` with `?? ""` before invoking the
 * caller's handler.
 */

import * as React from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type ComboboxItemShape = {
  value: string
  label: string
  disabled?: boolean
}

// ---------------------------------------------------------------------------
// Low-level primitives (mirror Select primitives 1:1).

function ComboboxRoot<T extends string | number = string>(
  props: React.ComponentProps<typeof ComboboxPrimitive.Root<T, false>>
) {
  // Single-selection mode is the default when `multiple` is omitted.
  return <ComboboxPrimitive.Root<T, false> {...props} />
}

function ComboboxTrigger({
  className,
  size = "default",
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props & { size?: "sm" | "default" }) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=combobox-value]:line-clamp-1 *:data-[slot=combobox-value]:flex *:data-[slot=combobox-value]:items-center *:data-[slot=combobox-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.Icon
        render={
          <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
        }
      />
    </ComboboxPrimitive.Trigger>
  )
}

function ComboboxValue({
  className,
  ...props
}: ComboboxPrimitive.Value.Props & { className?: string }) {
  return (
    <span data-slot="combobox-value" className={cn("flex flex-1 text-left", className)}>
      <ComboboxPrimitive.Value {...props} />
    </span>
  )
}

function ComboboxContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "relative isolate z-50 max-h-(--available-height) min-w-(--anchor-width) max-w-[24rem] origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxInput({
  className,
  placeholder = "Search…",
  ...props
}: ComboboxPrimitive.Input.Props) {
  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
      <SearchIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      <ComboboxPrimitive.Input
        data-slot="combobox-input"
        placeholder={placeholder}
        className={cn(
          "flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}

function ComboboxList({
  className,
  children,
  ...props
}: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("max-h-72 overflow-y-auto overflow-x-hidden p-1 scroll-py-1", className)}
      {...props}
    >
      {children}
    </ComboboxPrimitive.List>
  )
}

function ComboboxEmpty({
  className,
  children,
  ...props
}: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("px-3 py-2 text-sm text-muted-foreground", className)}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Empty>
  )
}

function ComboboxGroup({
  className,
  ...props
}: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      data-slot="combobox-group"
      className={cn("scroll-my-1", className)}
      {...props}
    />
  )
}

function ComboboxGroupLabel({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-group-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function ComboboxItem({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">{children}</span>
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="combobox-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

// ---------------------------------------------------------------------------
// High-level convenience component (drop-in for many <Select> sites).

export type ComboboxProps = {
  value?: string
  onValueChange?: (value: string) => void
  items: ReadonlyArray<ComboboxItemShape>
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  disabled?: boolean
  required?: boolean
  className?: string
  contentClassName?: string
  size?: "sm" | "default"
  /** Renders a custom item body. Defaults to `item.label`. */
  renderItem?: (item: ComboboxItemShape) => React.ReactNode
  /** Optional id forwarded to the trigger button. */
  id?: string
  /** Forwarded to the input in case form labels rely on aria attrs. */
  "aria-label"?: string
  "aria-labelledby"?: string
}

function Combobox({
  value,
  onValueChange,
  items,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No matches",
  disabled,
  required,
  className,
  contentClassName,
  size = "default",
  renderItem,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: ComboboxProps) {
  // base-ui passes objects ({value,label}) through onValueChange; we use the
  // raw string IDs as item values so handlers stay simple, and pass the items
  // array for built-in label-based filtering.
  const itemsForFilter = React.useMemo(
    () => items.map((it) => ({ value: it.value, label: it.label })),
    [items]
  )

  // Look up the label for the current value so the trigger renders the human
  // text rather than the raw ID.
  const selectedLabel = React.useMemo(() => {
    if (value == null || value === "") return undefined
    return items.find((it) => it.value === value)?.label
  }, [items, value])

  const handleChange = React.useCallback(
    (next: string | null) => {
      onValueChange?.((next ?? "") as string)
    },
    [onValueChange]
  )

  return (
    <ComboboxPrimitive.Root<string, false>
      value={value ?? null}
      onValueChange={handleChange}
      items={itemsForFilter}
      disabled={disabled}
      required={required}
      itemToStringLabel={(v) =>
        items.find((it) => it.value === v)?.label ?? String(v ?? "")
      }
    >
      <ComboboxTrigger
        id={id}
        size={size}
        className={className}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
      >
        <ComboboxValue>
          {selectedLabel ?? (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent className={contentClassName}>
        <ComboboxInput placeholder={searchPlaceholder} />
        <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
        <ComboboxList>
          {(item: ComboboxItemShape) => (
            <ComboboxItem key={item.value} value={item.value} disabled={item.disabled}>
              {renderItem ? renderItem(item) : item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  )
}

export {
  Combobox,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxValue,
  ComboboxContent,
  ComboboxInput,
  ComboboxList,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxSeparator,
}
