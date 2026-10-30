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

// Below `sm` the name takes its own line and budget | left | menu sit under it.
// From `sm` up it is one row with a Spent/Received/Paid column, and from `xl`
// up the progress bars line up in a column of their own.
const GRID =
  "grid grid-cols-[minmax(0,1fr)_7.5rem_2rem] sm:grid-cols-[minmax(0,1fr)_7rem_6.5rem_8rem_2rem] xl:grid-cols-[minmax(0,1fr)_minmax(6rem,13rem)_7rem_6.5rem_8rem_2rem] items-center gap-x-3 gap-y-0.5";
const NAME = "col-span-3 sm:col-span-1 min-w-0";
const ROW = `${GRID} rounded-md px-2 py-1 hover:bg-muted/40`;
const NUM = "font-mono text-xs tabular-nums";

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

type BarTone = "ok" | "warn" | "over" | "muted";
const BAR_TONE: Record<BarTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  over: "bg-rose-500",
  muted: "bg-muted-foreground/40",
};

interface BarSpec {
  value: number;
  target: number;
  tone: BarTone;
}

/** Spent out of what was available (budget + carried in); none when nothing is budgeted. */
function spendBar(x: Pick<BudgetLine, "budgeted" | "carriedIn" | "left" | "status">): BarSpec | null {
  if (x.left == null) return null;
  const target = (x.budgeted ?? 0) + (x.carriedIn ?? 0);
  if (target <= 0.005) return null;
  const value = target - x.left;
  const tone: BarTone = x.status === "over" ? "over" : x.status === "warn" || value / target >= 0.9 ? "warn" : "ok";
  return { value, target, tone };
}

function ProgressBar({ bar }: { bar: BarSpec }) {
  const pct = Math.max(0, Math.min(100, (bar.value / bar.target) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${BAR_TONE[bar.tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The bar under the name, below `xl`. */
function InlineBar({ bar }: { bar: BarSpec | null }) {
  return bar ? (
    <div className="mt-1 xl:hidden">
      <ProgressBar bar={bar} />
    </div>
  ) : null;
}

/** The bar's own column from `xl` up. Always rendered so the columns stay aligned. */
function BarColumn({ bar }: { bar: BarSpec | null }) {
  return <div className="hidden xl:block">{bar && <ProgressBar bar={bar} />}</div>;
}

function LeftCell({ line, currency }: { line: Pick<BudgetLine, "left" | "status" | "upcoming" | "actual">; currency: string }) {
  if (line.status === "unbudgeted" || line.left == null) {
    // Spending with no plan behind it is worth a second look.
    return (
      <span className={`text-xs ${line.actual > 0.005 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
        not budgeted
      </span>
    );
  }
  const after = line.left - line.upcoming;
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 ${NUM} ${pillClass(line.status)}`}
      title={line.upcoming > 0 ? `${formatCurrency(line.upcoming, currency)} still due this month; ${formatCurrency(after, currency)} left after it` : undefined}
    >
      {formatCurrency(line.left, currency)}
    </span>
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
        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label={label}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      }
    />
  );
}

/**
 * The small line under a name. On phones the Spent column is hidden, so the
 * amount spent rides here instead.
 */
function SubText({
  line,
  currency,
  showSpent,
}: {
  line: Pick<BudgetLine, "carriedIn" | "upcoming" | "rollover" | "actual">;
  currency: string;
  showSpent: boolean;
}) {
  const bits: React.ReactNode[] = [];
  if (showSpent && line.actual !== 0) {
    bits.push(
      <span key="s" className="sm:hidden">
        spent {formatCurrency(line.actual, currency)}
      </span>,
    );
  }
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
  const bar = inGroupBudget ? null : spendBar(line);
  return (
    <div className={`${ROW} pl-6`}>
      <div className={NAME}>
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
        <SubText line={line} currency={cur} showSpent={!inGroupBudget} />
        <InlineBar bar={bar} />
      </div>
      <BarColumn bar={bar} />
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
      <div className={`hidden sm:block text-right ${NUM}`}>
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
          <span className={`${NUM} text-muted-foreground sm:hidden`}>{formatCurrency(line.actual, cur)}</span>
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

/**
 * The lines a filter shows from one group, or null when it hides the group.
 * A group budgeted as one line is matched as a whole.
 */
function visibleLinesFor(group: BudgetGroup, filter: BudgetFilter): BudgetLine[] | null {
  if (filter === "all") return group.lines;
  const match = (x: Pick<BudgetLine, "status" | "upcoming">) =>
    filter === "unbudgeted" ? x.status === "unbudgeted" : filter === "over" ? x.status === "over" : x.upcoming > 0;
  if (group.byGroup) return match(group) ? group.lines : null;
  const lines = group.lines.filter(match);
  return lines.length ? lines : null;
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
  const visibleLines = visibleLinesFor(group, filter);
  if (!visibleLines) return null;
  const bar = spendBar(group);
  const count = group.lines.length;
  return (
    <div className="border-t first:border-t-0">
      <div className={`${GRID} px-2 py-1.5`}>
        <div className={NAME}>
          <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex w-full min-w-0 items-center gap-1.5 text-left">
            {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <span className="truncate text-sm font-semibold">{group.name}</span>
            {group.byGroup && <span className="shrink-0 rounded bg-primary/10 px-1.5 text-[10px] font-medium text-primary">one budget</span>}
            {group.rollover && <Repeat2 className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Rolls over" />}
            {collapsed && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {count} categor{count === 1 ? "y" : "ies"}
              </span>
            )}
          </button>
          {group.byGroup && <SubText line={group} currency={cur} showSpent />}
          <InlineBar bar={bar} />
        </div>
        <BarColumn bar={bar} />
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
            <span className={`block pr-2 text-right font-medium ${NUM}`}>
              {group.budgeted != null ? formatCurrency(group.budgeted, cur) : <span className="text-muted-foreground">—</span>}
            </span>
          )}
        </div>
        <div className={`hidden sm:block text-right font-medium ${NUM}`}>{formatCurrency(group.actual, cur)}</div>
        <div className="text-right">
          {group.byGroup ? (
            <LeftCell line={group} currency={cur} />
          ) : group.left != null ? (
            <span className={`pr-2 font-medium ${NUM} ${group.left < -0.005 ? "text-rose-600 dark:text-rose-400" : ""}`}>
              {formatCurrency(group.left, cur)}
            </span>
          ) : null}
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
      {!collapsed && (
        <div>
          {visibleLines.map((l) => (
            <SpendingLineRow key={l.key} line={l} data={data} inGroupBudget={group.byGroup} actions={actions} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The section's title and column labels in one row. With a toolbar the title
 * shares its own row with the toolbar and the labels sit underneath.
 */
function SectionHeader({
  title,
  budgetLabel,
  actualLabel,
  leftLabel,
  toolbar,
}: {
  title: string;
  budgetLabel: string;
  actualLabel: string;
  leftLabel: string;
  toolbar?: React.ReactNode;
}) {
  const label = "text-right text-[11px] uppercase tracking-wide text-muted-foreground";
  const heading = <h3 className="text-sm font-semibold">{title}</h3>;
  return (
    <>
      {toolbar && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1.5 pt-0.5">
          {heading}
          {toolbar}
        </div>
      )}
      <div className={`${GRID} border-b px-2 pb-1.5 ${toolbar ? "" : "pt-0.5"}`}>
        {toolbar ? <span className="hidden sm:block" /> : <div className={NAME}>{heading}</div>}
        <span className="hidden xl:block" />
        <span className={`pr-2 ${label}`}>{budgetLabel}</span>
        <span className={`hidden sm:block ${label}`}>{actualLabel}</span>
        <span className={`pr-2 ${label}`}>{leftLabel}</span>
        <span />
      </div>
    </>
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
          {g.lines.map((l) => {
            const bar: BarSpec | null = l.budgeted != null && l.budgeted > 0 ? { value: l.actual, target: l.budgeted, tone: "ok" } : null;
            return (
              <div key={l.key} className={ROW}>
                <div className={NAME}>
                  <span className="block truncate text-sm">{l.name}</span>
                  <InlineBar bar={bar} />
                </div>
                <BarColumn bar={bar} />
                <BudgetCell value={l.budgeted} currency={cur} label={`Expected income from ${l.name}`} onSave={(v) => actions.setLine(l.key, v)} />
                <span className={`hidden sm:block text-right ${NUM}`}>{formatCurrency(l.actual, cur)}</span>
                <span className="text-right">
                  {l.budgeted == null ? (
                    <span className={`${NUM} text-muted-foreground sm:hidden`}>{formatCurrency(l.actual, cur)}</span>
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
            );
          })}
        </div>
      ))}
    </section>
  );
}

const STATUS_TEXT: Record<DebtLine["status"], string> = { paid: "paid", due: "due", late: "late", none: "nothing due" };
const DEBT_TONE: Record<DebtLine["status"], { pill: BudgetLine["status"]; bar: BarTone }> = {
  paid: { pill: "ok", bar: "ok" },
  late: { pill: "over", bar: "over" },
  due: { pill: "warn", bar: "warn" },
  none: { pill: "unbudgeted", bar: "muted" },
};

export function DebtSection({ data, actions }: { data: BudgetMonth; actions: RowActions }) {
  if (!data.debt.length) return null;
  const cur = data.currency;
  return (
    <section className="rounded-xl border bg-card p-2">
      <SectionHeader title="Debt payments" budgetLabel="Planned" actualLabel="Paid" leftLabel="Status" />
      {data.debt.map((d) => {
        const due = d.dueDates.find((x) => x >= data.today) ?? d.dueDates[d.dueDates.length - 1];
        const statusText = d.status === "due" && due ? `due ${due.slice(5)}` : STATUS_TEXT[d.status];
        const tone = DEBT_TONE[d.status];
        const bar: BarSpec | null = d.planned > 0 ? { value: d.paid, target: d.planned, tone: tone.bar } : null;
        return (
          <div key={d.accountId} className={ROW}>
            <div className={NAME}>
              <Link
                href={d.loanIds.length === 1 ? loanHref(d.loanIds[0]) : `/accounts/${d.accountId}`}
                className="block truncate text-sm hover:underline"
              >
                {d.name}
              </Link>
              {d.source === "schedule" && d.planned > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  {formatCurrency(d.principal, cur)} principal + {formatCurrency(d.interest, cur)} interest
                  <span className="sm:hidden"> · paid {formatCurrency(d.paid, cur)}</span>
                </div>
              )}
              {d.source === "none" && d.planned === 0 && (
                <div className="text-[11px] text-muted-foreground">No payment scheduled this month</div>
              )}
              <InlineBar bar={bar} />
            </div>
            <BarColumn bar={bar} />
            <span className={`pr-2 text-right ${NUM}`}>{formatCurrency(d.planned, cur)}</span>
            <span className={`hidden sm:block text-right ${NUM}`}>{formatCurrency(d.paid, cur)}</span>
            <span className="text-right">
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${pillClass(tone.pill)}`}>{statusText}</span>
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
      <p className="px-2 pb-0.5 pt-1 text-[11px] text-muted-foreground">
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
  toolbar,
}: {
  data: BudgetMonth;
  filter: BudgetFilter;
  collapsed: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  actions: RowActions;
  toolbar?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-2">
      <SectionHeader title="Spending" budgetLabel="Budgeted" actualLabel="Spent" leftLabel="Left" toolbar={toolbar} />
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
      {data.spending.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">No expense categories yet.</p>
      ) : (
        !data.spending.some((g) => visibleLinesFor(g, filter)) && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing to show for this filter this month.</p>
        )
      )}
    </section>
  );
}
