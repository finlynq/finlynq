"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight, MoreHorizontal, Repeat2, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCurrency } from "@/lib/currency";
import { buildTxDrillUrl } from "@/lib/transactions/drill-url";
import { loanHref } from "@/lib/hooks/useLinkedLoans";
import type { BudgetGroup, BudgetLine, BudgetMonth, DebtLine } from "@/lib/budgets/month";
import { monthEndDate, monthStartDate } from "@/lib/budgets/lines";
import { BudgetCell } from "./budget-cell";

export type BudgetFilter = "all" | "unbudgeted" | "over" | "upcoming";

export interface RowActions {
  setLine: (key: string, amount: number | null) => Promise<void>;
  categorySettings: (categoryId: number, patch: { excluded?: boolean; rollover?: boolean; rolloverNegative?: "carry" | "reset" }) => void;
  groupSettings: (group: string, patch: { excluded?: boolean; rollover?: boolean; rolloverNegative?: "carry" | "reset"; byGroup?: boolean }) => void;
  resetCarry: (key: string) => void;
  editCarry: (key: string, name: string, carriedIn: number) => void;
  openFill: (scope: { kind: "keys"; keys: string[]; label: string } | { kind: "group"; group: string; label: string }, section: "spending" | "income") => void;
  openSettings: () => void;
}

const GRID = "grid grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_2rem] sm:grid-cols-[minmax(0,1fr)_7rem_6.5rem_8rem_2rem] items-center gap-x-2";

function pillClass(status: BudgetLine["status"]): string {
  switch (status) {
    case "over":
      return "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300";
    case "warn":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300";
    case "received":
    case "ok":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function LeftCell({ line, currency }: { line: Pick<BudgetLine, "left" | "status" | "upcoming" | "budgeted">; currency: string }) {
  if (line.status === "unbudgeted" || line.left == null) {
    return <span className="text-xs text-muted-foreground">not budgeted</span>;
  }
  const after = line.left - line.upcoming;
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 font-mono text-xs tabular-nums ${pillClass(line.status)}`}
      title={line.upcoming > 0 ? `${formatCurrency(line.upcoming, currency)} still due this month; ${formatCurrency(after, currency)} left after it` : undefined}
    >
      {formatCurrency(line.left, currency)}
    </span>
  );
}

function Bar({ actual, budget }: { actual: number; budget: number | null }) {
  if (budget == null || budget <= 0) return null;
  const pct = Math.min(100, (actual / budget) * 100);
  const color = actual > budget ? "bg-rose-500" : pct >= 85 ? "bg-amber-500" : "bg-primary";
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function RolloverMenuItems({
  rollover,
  negative,
  carriedIn,
  name,
  lineKey,
  actions,
  onToggle,
  onNegative,
}: {
  rollover: boolean;
  negative: "carry" | "reset";
  carriedIn: number | null;
  name: string;
  lineKey: string;
  actions: RowActions;
  onToggle: (on: boolean) => void;
  onNegative: (n: "carry" | "reset") => void;
}) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Carryover</DropdownMenuLabel>
      <DropdownMenuCheckboxItem checked={rollover} onCheckedChange={(v) => onToggle(!!v)}>
        Roll leftover into next month
      </DropdownMenuCheckboxItem>
      {rollover && (
        <>
          <DropdownMenuCheckboxItem checked={negative === "carry"} onCheckedChange={(v) => onNegative(v ? "carry" : "reset")}>
            Carry overspending too
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem onClick={() => actions.resetCarry(lineKey)}>Reset carryover to 0 from this month</DropdownMenuItem>
          <DropdownMenuItem onClick={() => actions.editCarry(lineKey, name, carriedIn ?? 0)}>Set carried in…</DropdownMenuItem>
        </>
      )}
    </DropdownMenuGroup>
  );
}

function MenuButton({ label }: { label: string }) {
  return (
    <DropdownMenuTrigger
      render={
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" aria-label={label}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      }
    />
  );
}

function SubText({ line, currency }: { line: Pick<BudgetLine, "carriedIn" | "upcoming" | "rollover">; currency: string }) {
  const bits: React.ReactNode[] = [];
  if (line.rollover && line.carriedIn != null && line.carriedIn !== 0) {
    bits.push(<span key="c">carried in {formatCurrency(line.carriedIn, currency)}</span>);
  }
  if (line.upcoming > 0) bits.push(<span key="u">{formatCurrency(line.upcoming, currency)} due later</span>);
  if (!bits.length) return null;
  return <div className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">{bits}</div>;
}

function SpendingLineRow({
  line,
  data,
  inGroupBudget,
  actions,
}: {
  line: BudgetLine;
  data: BudgetMonth;
  inGroupBudget: boolean;
  actions: RowActions;
}) {
  const cur = data.currency;
  const drill = line.categoryId
    ? buildTxDrillUrl({ categoryId: String(line.categoryId), startDate: monthStartDate(data.month), endDate: monthEndDate(data.month) })
    : null;
  return (
    <div className={`${GRID} rounded-md px-2 py-1.5 hover:bg-muted/40`}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {line.categoryId ? (
            <Link href={`/categories/${line.categoryId}`} className="truncate text-sm hover:underline">
              {line.name}
            </Link>
          ) : (
            <span className="truncate text-sm">{line.name}</span>
          )}
          {line.rollover && <Repeat2 className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Rolls over" />}
          {line.upcoming > 0 && <CalendarClock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Payments due later this month" />}
        </div>
        <SubText line={line} currency={cur} />
        {!inGroupBudget && <Bar actual={line.actual} budget={line.budgeted != null ? line.budgeted + (line.carriedIn ?? 0) : null} />}
      </div>
      <div>
        {inGroupBudget ? (
          <span className="block text-right text-xs text-muted-foreground">in group</span>
        ) : (
          <BudgetCell
            value={line.budgeted}
            currency={cur}
            hint={line.average3}
            label={`Budget for ${line.name}`}
            onSave={(v) => actions.setLine(line.key, v)}
          />
        )}
      </div>
      <div className="hidden sm:block text-right font-mono text-xs tabular-nums">
        {drill ? (
          <Link href={drill} className="hover:underline">
            {formatCurrency(line.actual, cur)}
          </Link>
        ) : (
          formatCurrency(line.actual, cur)
        )}
      </div>
      <div className="text-right">
        {inGroupBudget ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground sm:hidden">{formatCurrency(line.actual, cur)}</span>
        ) : (
          <LeftCell line={line} currency={cur} />
        )}
      </div>
      <DropdownMenu>
        <MenuButton label={`Options for ${line.name}`} />
        <DropdownMenuContent align="end" className="min-w-64">
          {!inGroupBudget && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Budget</DropdownMenuLabel>
              {line.average3 > 0 && (
                <DropdownMenuItem onClick={() => void actions.setLine(line.key, Math.round(line.average3))}>
                  Use the 3-month average ({formatCurrency(Math.round(line.average3), cur, { decimals: 0 })})
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => actions.openFill({ kind: "keys", keys: [line.key], label: line.name }, "spending")}>
                Fill this and later months…
              </DropdownMenuItem>
              {line.budgeted != null && (
                <DropdownMenuItem onClick={() => void actions.setLine(line.key, null)}>Clear this month&apos;s budget</DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          )}
          {!inGroupBudget && line.categoryId && (
            <>
              <DropdownMenuSeparator />
              <RolloverMenuItems
                rollover={line.rollover}
                negative={line.rolloverNegative}
                carriedIn={line.carriedIn}
                name={line.name}
                lineKey={line.key}
                actions={actions}
                onToggle={(on) => actions.categorySettings(line.categoryId!, { rollover: on })}
                onNegative={(n) => actions.categorySettings(line.categoryId!, { rolloverNegative: n })}
              />
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {line.categoryId && (
              <DropdownMenuItem onClick={() => actions.categorySettings(line.categoryId!, { excluded: true })}>
                Leave out of the budget
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SpendingGroupBlock({
  group,
  data,
  collapsed,
  onToggle,
  filter,
  actions,
}: {
  group: BudgetGroup;
  data: BudgetMonth;
  collapsed: boolean;
  onToggle: () => void;
  filter: BudgetFilter;
  actions: RowActions;
}) {
  const cur = data.currency;
  const rawName = group.key.slice(2);
  const visibleLines = group.byGroup
    ? group.lines
    : group.lines.filter((l) =>
        filter === "all" ? true : filter === "unbudgeted" ? l.status === "unbudgeted" : filter === "over" ? l.status === "over" : l.upcoming > 0,
      );
  if (!group.byGroup && filter !== "all" && visibleLines.length === 0) return null;
  if (group.byGroup && filter !== "all") {
    const match = filter === "unbudgeted" ? group.status === "unbudgeted" : filter === "over" ? group.status === "over" : group.upcoming > 0;
    if (!match) return null;
  }
  return (
    <div className="border-t first:border-t-0">
      <div className={`${GRID} bg-muted/40 px-2 py-1.5`}>
        <button type="button" onClick={onToggle} className="flex min-w-0 items-center gap-1.5 text-left text-sm font-medium">
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{group.name}</span>
          {group.byGroup && <span className="shrink-0 rounded bg-primary/10 px-1.5 text-[10px] font-medium text-primary">one budget</span>}
          {group.rollover && <Repeat2 className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Rolls over" />}
          <span className="shrink-0 text-xs font-normal text-muted-foreground">{group.lines.length}</span>
        </button>
        <div>
          {group.byGroup ? (
            <BudgetCell
              value={group.budgeted}
              currency={cur}
              hint={group.average3}
              label={`Budget for the ${group.name} group`}
              onSave={(v) => actions.setLine(group.key, v)}
            />
          ) : (
            <span className="block text-right font-mono text-xs tabular-nums text-muted-foreground">
              {group.budgeted != null ? formatCurrency(group.budgeted, cur) : "—"}
            </span>
          )}
        </div>
        <div className="hidden sm:block text-right font-mono text-xs tabular-nums">{formatCurrency(group.actual, cur)}</div>
        <div className="text-right">
          {group.byGroup ? (
            <LeftCell line={group} currency={cur} />
          ) : (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {group.left != null ? formatCurrency(group.left, cur) : ""}
            </span>
          )}
        </div>
        <DropdownMenu>
          <MenuButton label={`Options for the ${group.name} group`} />
          <DropdownMenuContent align="end" className="min-w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Group budget</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={group.byGroup}
                onCheckedChange={(v) => actions.groupSettings(rawName, { byGroup: !!v })}
              >
                Budget as one line
              </DropdownMenuCheckboxItem>
              {group.byGroup && group.average3 > 0 && (
                <DropdownMenuItem onClick={() => void actions.setLine(group.key, Math.round(group.average3))}>
                  Use the 3-month average ({formatCurrency(Math.round(group.average3), cur, { decimals: 0 })})
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => actions.openFill({ kind: "group", group: rawName, label: group.name }, "spending")}>
                Fill this group…
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {group.byGroup && (
              <>
                <DropdownMenuSeparator />
                <RolloverMenuItems
                  rollover={group.rollover}
                  negative={group.rolloverNegative}
                  carriedIn={group.carriedIn}
                  name={group.name}
                  lineKey={group.key}
                  actions={actions}
                  onToggle={(on) => actions.groupSettings(rawName, { rollover: on })}
                  onNegative={(n) => actions.groupSettings(rawName, { rolloverNegative: n })}
                />
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => actions.groupSettings(rawName, { excluded: true })}>
                Leave the group out of the budget
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!collapsed &&
        visibleLines.map((l) => (
          <SpendingLineRow key={l.key} line={l} data={data} inGroupBudget={group.byGroup} actions={actions} />
        ))}
    </div>
  );
}

function SectionHeader({ title, budgetLabel, actualLabel, leftLabel }: { title: string; budgetLabel: string; actualLabel: string; leftLabel: string }) {
  return (
    <div className={`${GRID} px-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground`}>
      <span>{title}</span>
      <span className="text-right">{budgetLabel}</span>
      <span className="hidden sm:block text-right">{actualLabel}</span>
      <span className="text-right">{leftLabel}</span>
      <span />
    </div>
  );
}

export function IncomeSection({ data, actions }: { data: BudgetMonth; actions: RowActions }) {
  if (!data.income.length) return null;
  const cur = data.currency;
  return (
    <section className="rounded-xl border bg-card p-2">
      <SectionHeader title="Income" budgetLabel="Expected" actualLabel="Received" leftLabel="Status" />
      {data.income.map((g) => (
        <div key={g.key} className="border-t first:border-t-0">
          {data.income.length > 1 && <div className="px-2 pt-1.5 text-xs font-medium text-muted-foreground">{g.name}</div>}
          {g.lines.map((l) => (
            <div key={l.key} className={`${GRID} rounded-md px-2 py-1.5 hover:bg-muted/40`}>
              <span className="truncate text-sm">{l.name}</span>
              <BudgetCell value={l.budgeted} currency={cur} label={`Expected income from ${l.name}`} onSave={(v) => actions.setLine(l.key, v)} />
              <span className="hidden sm:block text-right font-mono text-xs tabular-nums">{formatCurrency(l.actual, cur)}</span>
              <span className="text-right">
                {l.budgeted == null ? (
                  <span className="text-xs text-muted-foreground sm:hidden">{formatCurrency(l.actual, cur)}</span>
                ) : (
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${pillClass(l.status)}`}>
                    {l.status === "received" ? "received" : `${formatCurrency(Math.max(0, l.left ?? 0), cur)} to come`}
                  </span>
                )}
              </span>
              <DropdownMenu>
                <MenuButton label={`Options for ${l.name}`} />
                <DropdownMenuContent align="end" className="min-w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => actions.openFill({ kind: "keys", keys: [l.key], label: l.name }, "income")}>
                      Fill this and later months…
                    </DropdownMenuItem>
                    {l.categoryId && (
                      <DropdownMenuItem onClick={() => actions.categorySettings(l.categoryId!, { excluded: true })}>
                        Leave out of the budget
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

const STATUS_TEXT: Record<DebtLine["status"], string> = { paid: "paid", due: "due", late: "late", none: "nothing due" };

export function DebtSection({ data, actions }: { data: BudgetMonth; actions: RowActions }) {
  if (!data.debt.length) return null;
  const cur = data.currency;
  return (
    <section className="rounded-xl border bg-card p-2">
      <SectionHeader title="Debt payments" budgetLabel="Planned" actualLabel="Paid" leftLabel="Status" />
      {data.debt.map((d) => {
        const due = d.dueDates.find((x) => x >= data.today) ?? d.dueDates[d.dueDates.length - 1];
        const statusText = d.status === "due" && due ? `due ${due.slice(5)}` : STATUS_TEXT[d.status];
        const pill =
          d.status === "paid" ? pillClass("ok") : d.status === "late" ? pillClass("over") : d.status === "due" ? pillClass("warn") : pillClass("unbudgeted");
        return (
          <div key={d.accountId} className={`${GRID} rounded-md px-2 py-1.5 hover:bg-muted/40`}>
            <div className="min-w-0">
              {d.loanIds.length === 1 ? (
                <Link href={loanHref(d.loanIds[0])} className="block truncate text-sm hover:underline">
                  {d.name}
                </Link>
              ) : (
                <Link href={`/accounts/${d.accountId}`} className="block truncate text-sm hover:underline">
                  {d.name}
                </Link>
              )}
              {d.source === "schedule" && d.planned > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  {formatCurrency(d.principal, cur)} principal + {formatCurrency(d.interest, cur)} interest
                </div>
              )}
              {d.source === "none" && d.planned === 0 && (
                <div className="text-[11px] text-muted-foreground">No payment scheduled this month</div>
              )}
            </div>
            <span className="text-right font-mono text-xs tabular-nums">{formatCurrency(d.planned, cur)}</span>
            <span className="hidden sm:block text-right font-mono text-xs tabular-nums">{formatCurrency(d.paid, cur)}</span>
            <span className="text-right">
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${pill}`}>{statusText}</span>
            </span>
            <DropdownMenu>
              <MenuButton label={`Options for ${d.name}`} />
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={actions.openSettings}>Change how this account counts…</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
      <p className="px-2 pt-1 text-[11px] text-muted-foreground">
        A payment&apos;s interest is part of its line here, not counted again under its expense category.
      </p>
    </section>
  );
}

export function SpendingSection({
  data,
  filter,
  collapsed,
  onToggleGroup,
  actions,
}: {
  data: BudgetMonth;
  filter: BudgetFilter;
  collapsed: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  actions: RowActions;
}) {
  return (
    <section className="rounded-xl border bg-card p-2">
      <SectionHeader title="Spending" budgetLabel="Budgeted" actualLabel="Spent" leftLabel="Left" />
      {data.spending.map((g) => (
        <SpendingGroupBlock
          key={g.key}
          group={g}
          data={data}
          collapsed={collapsed.has(g.key)}
          onToggle={() => onToggleGroup(g.key)}
          filter={filter}
          actions={actions}
        />
      ))}
      {data.spending.length === 0 && (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">No expense categories yet.</p>
      )}
    </section>
  );
}
