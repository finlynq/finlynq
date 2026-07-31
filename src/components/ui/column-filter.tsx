"use client";

/**
 * ColumnFilterPopover — the shared per-column header filter.
 *
 * Lifted from `transactions/_components/column-filter-popover.tsx` (issue #59),
 * which was the app's only implementation. The ONLY thing that made it
 * transaction-specific was its enum branch, which hardcoded four `columnId`
 * cases (source / category / account / accountType) and read `accounts` +
 * `categories` props directly; that is now an injected `options` list, so any
 * table can use it. Everything else — the draft-state-until-Apply behaviour,
 * the base-ui keydown workaround, the drop-empty-filters rule on Apply — is
 * carried over unchanged.
 *
 * Draft state matters: the popover edits a LOCAL copy and only calls `onChange`
 * on Apply. For a server-filtered table, committing per keystroke would fire a
 * request per character.
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Filter } from "lucide-react";
import {
  isEmptyFilter,
  type FilterOption,
  type TableColFilter,
  type TableFilterType,
} from "@/lib/table-filters";

export interface ColumnFilterPopoverProps {
  columnId: string;
  filterType: TableFilterType;
  activeFilter: TableColFilter | undefined | null;
  onChange: (f: TableColFilter | null) => void;
  /** Choices for `filterType: "enum"`. Ignored for other types. */
  options?: FilterOption[];
}

export function ColumnFilterPopover({
  columnId,
  filterType,
  activeFilter,
  onChange,
  options = [],
}: ColumnFilterPopoverProps) {
  const isActive = !!activeFilter;
  // Local draft so the user can type without firing one request per keystroke.
  // Committed on Apply.
  const [draft, setDraft] = useState<TableColFilter | null>(
    activeFilter ?? null,
  );
  useEffect(() => {
    setDraft(activeFilter ?? null);
  }, [activeFilter]);

  const initDraft = (): TableColFilter => {
    if (filterType === "date") return { type: "date", columnId };
    if (filterType === "text") return { type: "text", columnId, value: "" };
    if (filterType === "numeric")
      return { type: "numeric", columnId, op: "eq", value: 0 };
    return { type: "enum", columnId, values: [] };
  };

  // base-ui Menu.Root attaches keydown listeners on the menu surface for
  // type-ahead (printable chars) and back/close (Backspace). Without this
  // stopPropagation the input never sees its own keystrokes — the menu eats
  // them first. Escape and Tab still bubble so close + focus traversal work.
  const swallowMenuKeys = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={`p-0.5 rounded hover:bg-muted transition-colors ${isActive ? "text-primary" : "text-muted-foreground/60"}`}
            title={isActive ? "Filter active — click to edit" : "Filter column"}
            aria-label={isActive ? "Edit column filter" : "Filter column"}
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <Filter className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64 p-3 space-y-2">
        {filterType === "date" && (
          <>
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              className="h-8 text-xs"
              value={(draft as { from?: string } | null)?.from ?? ""}
              onChange={(e) => {
                const cur = draft ?? initDraft();
                if (cur.type !== "date") return;
                setDraft({ ...cur, from: e.target.value || undefined });
              }}
              onKeyDown={swallowMenuKeys}
            />
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              className="h-8 text-xs"
              value={(draft as { to?: string } | null)?.to ?? ""}
              onChange={(e) => {
                const cur = draft ?? initDraft();
                if (cur.type !== "date") return;
                setDraft({ ...cur, to: e.target.value || undefined });
              }}
              onKeyDown={swallowMenuKeys}
            />
          </>
        )}
        {filterType === "text" && (
          <>
            <Label className="text-xs">Contains</Label>
            <Input
              className="h-8 text-xs"
              placeholder="Substring…"
              value={(draft as { value?: string } | null)?.value ?? ""}
              onChange={(e) =>
                setDraft({ type: "text", columnId, value: e.target.value })
              }
              onKeyDown={swallowMenuKeys}
            />
          </>
        )}
        {filterType === "numeric" && (
          <>
            <Label className="text-xs">Operator</Label>
            <Select
              value={(draft as { op?: string } | null)?.op ?? "eq"}
              onValueChange={(v) => {
                const op = (v ?? "eq") as "eq" | "gt" | "lt" | "between";
                const cur =
                  draft && draft.type === "numeric"
                    ? draft
                    : { type: "numeric" as const, columnId, value: 0, op };
                setDraft({ ...cur, op } as TableColFilter);
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="eq">=</SelectItem>
                <SelectItem value="gt">&gt;</SelectItem>
                <SelectItem value="lt">&lt;</SelectItem>
                <SelectItem value="between">Between</SelectItem>
              </SelectContent>
            </Select>
            <Label className="text-xs">Value</Label>
            <Input
              type="number"
              className="h-8 text-xs"
              value={(draft as { value?: number } | null)?.value ?? ""}
              onChange={(e) => {
                const n = e.target.value === "" ? 0 : Number(e.target.value);
                if (!Number.isFinite(n)) return;
                const cur =
                  draft && draft.type === "numeric"
                    ? draft
                    : {
                        type: "numeric" as const,
                        columnId,
                        op: "eq" as const,
                        value: 0,
                      };
                setDraft({ ...cur, value: n } as TableColFilter);
              }}
              onKeyDown={swallowMenuKeys}
            />
            {draft?.type === "numeric" && draft.op === "between" && (
              <>
                <Label className="text-xs">Upper bound</Label>
                <Input
                  type="number"
                  className="h-8 text-xs"
                  value={draft.value2 ?? ""}
                  onChange={(e) => {
                    const n =
                      e.target.value === "" ? undefined : Number(e.target.value);
                    if (n != null && !Number.isFinite(n)) return;
                    setDraft({ ...draft, value2: n });
                  }}
                  onKeyDown={swallowMenuKeys}
                />
              </>
            )}
          </>
        )}
        {filterType === "enum" && (
          <>
            <Label className="text-xs">Match any of</Label>
            <div className="max-h-48 overflow-y-auto space-y-1 border rounded p-2">
              {options.length === 0 && (
                <p className="text-xs text-muted-foreground">No options.</p>
              )}
              {options.map((opt) => {
                const checked =
                  draft?.type === "enum" && draft.values.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className="flex items-center gap-2 text-xs cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const cur =
                          draft && draft.type === "enum"
                            ? draft
                            : { type: "enum" as const, columnId, values: [] };
                        const values = e.target.checked
                          ? Array.from(new Set([...cur.values, opt.value]))
                          : cur.values.filter((v) => v !== opt.value);
                        setDraft({ ...cur, values });
                      }}
                    />
                    {opt.label}
                  </label>
                );
              })}
            </div>
          </>
        )}
        <DropdownMenuSeparator />
        <div className="flex gap-2 justify-end">
          {isActive && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => onChange(null)}
            >
              Clear
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onChange(isEmptyFilter(draft) ? null : draft)}
          >
            Apply
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
