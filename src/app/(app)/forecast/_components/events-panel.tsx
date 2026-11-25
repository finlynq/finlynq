"use client";

/**
 * Events editor (plan section 6): dated changes such as a one-off amount, a
 * new monthly line, a pay change, moving money to investments, extra loan
 * payments, a new loan, refinancing, buying a home, and a debt strategy.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { eventSchema, type EventKind, type ForecastEvent } from "@/lib/forecast/config";
import type { ForecastLineDef } from "@/lib/forecast/types";
import { cn } from "@/lib/utils";
import {
  ArrowUpDown, BarChart3, Bot, Car, Clock, Home, ListOrdered, Pencil, Plus, RefreshCw, Repeat, Trash2, TrendingUp,
  type LucideIcon,
} from "lucide-react";

export const EVENT_LABEL: Record<EventKind, string> = {
  one_off: "One-off amount",
  recurring_item: "New monthly line",
  income_change: "Pay change",
  move_money: "Move money to/from investments",
  extra_debt_payment: "Extra loan payment",
  new_loan: "New loan",
  refinance: "Refinance a loan",
  buy_home: "Buy a home",
  debt_strategy: "Debt payoff strategy",
  retire: "Retire",
};

const EVENT_HELP: Record<EventKind, string> = {
  one_off: "Money in or out once: an inheritance, a wedding, a car bought in cash.",
  recurring_item: "A new income or expense every month for a while: daycare, side income.",
  income_change: "A raise, a pay cut, or no income for a few months.",
  move_money: "Save into investments (or take money out), once or every month.",
  extra_debt_payment: "Pay more on one loan, once or every month.",
  new_loan: "Borrow in this scenario (your real loans don't change).",
  refinance: "A new rate and term for one of your loans from a month.",
  buy_home: "Down payment, a mortgage, the home as an asset, yearly costs, rent stopping.",
  debt_strategy: "An extra amount every month at your loans, snowball or avalanche.",
  retire: "Income stops, spending changes, pensions start, and investments pay for the rest.",
};

/** The Add event picker: event kinds in three groups, with a short line each. */
const PICKER_GROUPS: Array<{ title: string; items: Array<{ kind: EventKind; title: string; hint: string; icon: LucideIcon }> }> = [
  {
    title: "Money in or out",
    items: [
      { kind: "one_off", title: "One-off amount", hint: "A bonus, a gift, a big purchase", icon: ArrowUpDown },
      { kind: "recurring_item", title: "New monthly cost or income", hint: "Daycare, a side job", icon: Repeat },
      { kind: "income_change", title: "Pay change", hint: "A raise, a new job, part time", icon: TrendingUp },
    ],
  },
  {
    title: "Debt",
    items: [
      { kind: "extra_debt_payment", title: "Extra loan payment", hint: "Monthly or one time", icon: Plus },
      { kind: "refinance", title: "Refinance", hint: "A new rate or term", icon: RefreshCw },
      { kind: "debt_strategy", title: "Debt payoff plan", hint: "Snowball or avalanche", icon: ListOrdered },
    ],
  },
  {
    title: "Big moves",
    items: [
      { kind: "buy_home", title: "Buy a home", hint: "Down payment and mortgage", icon: Home },
      { kind: "new_loan", title: "New loan", hint: "A car, a line of credit", icon: Car },
      { kind: "move_money", title: "Save into investments", hint: "Move cash every month", icon: BarChart3 },
    ],
  },
];

export type LoanOption = { key: string; label: string };

function nextMonth(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  return d.toISOString().slice(0, 7);
}

export function newEvent(kind: EventKind, month = nextMonth(), loans: LoanOption[] = []): ForecastEvent {
  const id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
  const base = { id, label: EVENT_LABEL[kind], enabled: true, month, updatedBy: "user" as const };
  const firstLoan = loans[0]?.key ?? "debt:0";
  const params: Record<EventKind, object> = {
    one_off: { direction: "out", amount: 1000 },
    recurring_item: { type: "expense", amount: 500, growthPct: 0 },
    income_change: { lineKeys: [], op: "scale", value: 1.03 },
    move_money: { direction: "to_investments", amount: 500, frequency: "monthly" },
    extra_debt_payment: { loanKey: firstLoan, amount: 200, frequency: "monthly" },
    new_loan: { principal: 20000, annualRatePct: 6, termMonths: 60, cashIn: true },
    refinance: { loanKey: firstLoan, annualRatePct: 4, termMonths: 240 },
    buy_home: { price: 500000, downPayment: 100000, mortgageRatePct: 5, mortgageTermMonths: 300, yearlyCostsPct: 1.5, stopLineKeys: [] },
    debt_strategy: { method: "avalanche", extraPerMonth: 300 },
    retire: { stopIncomeLineKeys: [], spendingFactor: 0.8, pensions: [], stopContributions: true, withdrawal: { method: "cover_shortfall" } },
  };
  return eventSchema.parse({ ...base, kind, params: params[kind] });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym?: string) => (ym ? `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : "");

function summary(e: ForecastEvent, loanName: (k: string) => string): string {
  const p = e.params as Record<string, unknown>;
  const to = p.to ? ` to ${monthLabel(p.to as string)}` : "";
  switch (e.kind) {
    case "one_off": return `${p.direction === "in" ? "In" : "Out"} ${p.amount} in ${monthLabel(e.month)}`;
    case "recurring_item": return `${p.type === "income" ? "Income" : "Expense"} ${p.amount}/month from ${monthLabel(e.month)}${to}`;
    case "income_change": return `${p.op === "scale" ? `× ${p.value}` : `${p.value}/month`} from ${monthLabel(e.month)}${to}`;
    case "move_money": return `${p.amount} ${p.direction === "to_investments" ? "to" : "from"} investments, ${p.frequency === "once" ? "once" : "monthly"} from ${monthLabel(e.month)}${to}`;
    case "extra_debt_payment": return `${p.amount} extra on ${loanName(p.loanKey as string)}, ${p.frequency === "once" ? "once" : "monthly"} from ${monthLabel(e.month)}${to}`;
    case "new_loan": return `${p.principal} at ${p.annualRatePct}% over ${p.termMonths} months from ${monthLabel(e.month)}`;
    case "refinance": return `${loanName(p.loanKey as string)} at ${p.annualRatePct}% over ${p.termMonths} months from ${monthLabel(e.month)}`;
    case "buy_home": return `${p.price} home, ${p.downPayment} down, ${p.mortgageRatePct}% over ${p.mortgageTermMonths} months, ${monthLabel(e.month)}`;
    case "debt_strategy": return `${p.method === "snowball" ? "Snowball" : "Avalanche"}, ${p.extraPerMonth} extra a month from ${monthLabel(e.month)}`;
    case "retire": {
      const w = p.withdrawal as { method: string; pct?: number; amount?: number };
      const how = w.method === "fixed_pct" ? `${w.pct}% a year from investments` : w.method === "fixed_amount" ? `${w.amount}/month from investments` : "investments cover what's short";
      const pens = (p.pensions as unknown[]).length;
      return `${monthLabel(e.month)}, spending ${Math.round(Number(p.spendingFactor) * 100)}%, ${pens} pension${pens === 1 ? "" : "s"}, ${how}`;
    }
  }
}

export function EventsPanel({
  events,
  lines,
  loans,
  onChange,
}: {
  events: ForecastEvent[];
  lines: ForecastLineDef[];
  loans: LoanOption[];
  onChange: (events: ForecastEvent[]) => void;
}) {
  const [editing, setEditing] = useState<ForecastEvent | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Loans this scenario creates can take extra payments / be refinanced too.
  const allLoans: LoanOption[] = [
    ...loans,
    ...events.filter((e) => e.kind === "new_loan").map((e) => ({ key: `newloan:${e.id}`, label: e.label || "New loan" })),
    ...events.filter((e) => e.kind === "buy_home").map((e) => ({ key: `newloan:${e.id}`, label: `${e.label || "Home"}: mortgage` })),
  ];
  const loanName = (k: string) => allLoans.find((l) => l.key === k)?.label ?? "a loan";
  const sorted = [...events].sort((a, b) => a.month.localeCompare(b.month));

  const startNew = (k: EventKind) => {
    setPickerOpen(false);
    setEditing(newEvent(k, undefined, allLoans));
    setIsNew(true);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Events</h3>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-primary" onClick={() => setPickerOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add event
        </Button>
      </div>
      {sorted.length === 0 && <p className="text-sm text-muted-foreground">No events yet. Add one to see how a change plays out.</p>}
      {sorted.length > 0 && (
        <ol className="ml-1.5 border-l-2 border-border">
          {sorted.map((e) => (
            <li key={e.id} className={cn("relative flex items-start gap-2 py-1.5 pl-4", !e.enabled && "opacity-60")}>
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -left-[7px] top-3 h-3 w-3 rounded-full border-2",
                  e.enabled ? "border-primary bg-primary" : "border-dashed border-muted-foreground bg-card",
                )}
              />
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                aria-label={`Use ${e.label || EVENT_LABEL[e.kind]}`}
                checked={e.enabled}
                onChange={(ev) => onChange(events.map((x) => (x.id === e.id ? { ...x, enabled: ev.target.checked } : x)))}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  {e.label || EVENT_LABEL[e.kind]}
                  {!e.enabled && <span className="text-xs font-normal text-muted-foreground">off</span>}
                  {e.updatedBy === "assistant" && <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-label="Changed by your assistant" />}
                </p>
                <p className="text-xs text-muted-foreground">{summary(e, loanName)}</p>
              </div>
              <div className="flex shrink-0">
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit event" onClick={() => { setEditing(e); setIsNew(false); }}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label="Remove event" onClick={() => onChange(events.filter((x) => x.id !== e.id))}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <EventPicker open={pickerOpen} onOpenChange={setPickerOpen} hasLoans={allLoans.length > 0} onPick={startNew} />
      {editing && (
        <EventDialog
          event={editing}
          lines={lines}
          loans={allLoans.filter((l) => l.key !== `newloan:${editing.id}`)}
          title={isNew ? `Add: ${EVENT_LABEL[editing.kind]}` : `Edit ${editing.label || EVENT_LABEL[editing.kind]}`}
          onCancel={() => setEditing(null)}
          onSave={(saved) => {
            onChange(isNew ? [...events, saved] : events.map((x) => (x.id === saved.id ? saved : x)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** "What happens?": pick an event kind, then its dialog opens. */
export function EventPicker({
  open,
  onOpenChange,
  hasLoans,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasLoans: boolean;
  onPick: (kind: EventKind) => void;
}) {
  const needsLoan = (k: EventKind) => (k === "extra_debt_payment" || k === "refinance") && !hasLoans;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What happens?</DialogTitle>
          <DialogDescription>Pick one. You set the month and amounts next.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {PICKER_GROUPS.map((g) => (
            <div key={g.title} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {g.items.map(({ kind, title, hint, icon: Icon }) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={needsLoan(kind)}
                    title={needsLoan(kind) ? "You have no loans to change." : undefined}
                    onClick={() => onPick(kind)}
                    className="flex flex-col items-start gap-1 rounded-lg border bg-muted/30 p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                    <span className="text-sm font-medium">{title}</span>
                    <span className="text-xs text-muted-foreground">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onPick("retire")}
            className="flex w-full items-center gap-3 rounded-lg border border-primary/50 bg-primary/10 p-3 text-left transition-colors hover:bg-primary/15"
          >
            <Clock className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <span className="flex-1">
              <span className="block text-sm font-medium">Retire</span>
              <span className="block text-xs text-muted-foreground">Pay stops, pensions start, investments pay the rest. Shows how long your money lasts.</span>
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EventDialog({
  event,
  lines,
  loans,
  title,
  onCancel,
  onSave,
}: {
  event: ForecastEvent;
  lines: ForecastLineDef[];
  loans: LoanOption[];
  title: string;
  onCancel: () => void;
  onSave: (e: ForecastEvent) => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() => JSON.parse(JSON.stringify(event)));
  const [error, setError] = useState("");
  const p = (draft.params ?? {}) as Record<string, unknown>;
  const set = (k: string, v: unknown) => setDraft({ ...draft, params: { ...p, [k]: v } });
  const kind = event.kind;

  const numField = (key: string, label: string, opts: { step?: string; allowBlank?: boolean } = {}) => (
    <div className="space-y-1">
      <Label className="text-xs" htmlFor={`ev-${key}`}>{label}</Label>
      <Input
        id={`ev-${key}`}
        type="number"
        step={opts.step ?? "any"}
        className="h-8"
        value={p[key] == null ? "" : String(p[key])}
        onChange={(e) => set(key, e.target.value.trim() === "" ? (opts.allowBlank ? null : 0) : Number(e.target.value))}
      />
    </div>
  );
  const pick = (key: string, label: string, options: Array<[string, string]>) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={String(p[key] ?? options[0][0])} onValueChange={(v) => set(key, v)}>
        <SelectTrigger className="h-8 text-xs" aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>{options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
  const toField = (label = "Until (optional)") => (
    <div className="space-y-1">
      <Label className="text-xs" htmlFor="ev-to">{label}</Label>
      <Input id="ev-to" type="month" className="h-8" value={String(p.to ?? "")} onChange={(e) => set("to", e.target.value || undefined)} />
    </div>
  );
  const lineChecks = (key: string, type: "income" | "expense", help: string) => {
    const chosen = new Set((p[key] as string[]) ?? []);
    const options = lines.filter((l) => l.type === type);
    return (
      <div className="space-y-1">
        <Label className="text-xs">{help}</Label>
        <div className="max-h-36 overflow-y-auto rounded border p-2 space-y-1">
          {options.length === 0 && <p className="text-xs text-muted-foreground">No lines.</p>}
          {options.map((l) => (
            <label key={l.key} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={chosen.has(l.key)} onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(l.key); else next.delete(l.key);
                set(key, [...next]);
              }} />
              {l.label} <span className="text-muted-foreground">({l.group || type})</span>
            </label>
          ))}
        </div>
      </div>
    );
  };

  const save = () => {
    const parsed = eventSchema.safeParse({ ...draft, updatedBy: "user" });
    if (!parsed.success) {
      setError("Check the values: some are missing or not valid.");
      return;
    }
    onSave(parsed.data);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{EVENT_HELP[kind]}</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="ev-label">Name</Label>
              <Input id="ev-label" className="h-8" value={String(draft.label ?? "")} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="ev-month">{kind === "buy_home" ? "Purchase month" : "From month"}</Label>
              <Input id="ev-month" type="month" className="h-8" value={String(draft.month ?? "")} onChange={(e) => setDraft({ ...draft, month: e.target.value })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {kind === "one_off" && (<>{pick("direction", "Direction", [["out", "Money out"], ["in", "Money in"]])}{numField("amount", "Amount")}</>)}
            {kind === "recurring_item" && (<>
              {pick("type", "Type", [["expense", "Expense"], ["income", "Income"]])}
              {numField("amount", "Amount per month")}
              {toField()}
              {numField("growthPct", "Grows, % a year (blank = inflation)", { allowBlank: true, step: "0.1" })}
            </>)}
            {kind === "income_change" && (<>
              {pick("op", "Change", [["scale", "Multiply by"], ["set", "Set to (per month)"]])}
              {numField("value", p.op === "set" ? "Amount per month (0 = no income)" : "Factor (1.05 = +5%)")}
              {toField()}
            </>)}
            {kind === "move_money" && (<>
              {pick("direction", "Direction", [["to_investments", "Cash to investments"], ["from_investments", "Investments to cash"]])}
              {numField("amount", "Amount")}
              {pick("frequency", "How often", [["monthly", "Every month"], ["once", "Once"]])}
              {p.frequency !== "once" && toField()}
            </>)}
            {(kind === "extra_debt_payment" || kind === "refinance") && (
              <div className="space-y-1 col-span-2">
                <Label className="text-xs">Loan</Label>
                <Select value={String(p.loanKey ?? "")} onValueChange={(v) => set("loanKey", v)}>
                  <SelectTrigger className="h-8 text-xs" aria-label="Loan"><SelectValue placeholder="Pick a loan" /></SelectTrigger>
                  <SelectContent>{loans.map((l) => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            {kind === "extra_debt_payment" && (<>
              {numField("amount", "Extra amount")}
              {pick("frequency", "How often", [["monthly", "Every month"], ["once", "Once"]])}
              {p.frequency !== "once" && toField()}
            </>)}
            {kind === "refinance" && (<>{numField("annualRatePct", "New rate, % a year", { step: "0.01" })}{numField("termMonths", "New term, months", { step: "1" })}</>)}
            {kind === "new_loan" && (<>
              {numField("principal", "Amount borrowed")}
              {numField("annualRatePct", "Rate, % a year", { step: "0.01" })}
              {numField("termMonths", "Term, months", { step: "1" })}
              {pick("cashIn", "The money", [["true", "Lands in cash"], ["false", "Is spent at once (a car loan for the car)"]])}
            </>)}
            {kind === "buy_home" && (<>
              {numField("price", "Price")}
              {numField("downPayment", "Down payment")}
              {numField("mortgageRatePct", "Mortgage rate, % a year", { step: "0.01" })}
              {numField("mortgageTermMonths", "Mortgage term, months", { step: "1" })}
              {numField("yearlyCostsPct", "Tax, insurance, upkeep, % of price a year", { step: "0.1" })}
            </>)}
            {kind === "debt_strategy" && (<>
              {pick("method", "Order", [["avalanche", "Avalanche: highest rate first (least interest)"], ["snowball", "Snowball: smallest balance first"]])}
              {numField("extraPerMonth", "Extra per month")}
            </>)}
          </div>
          {kind === "retire" && (
            <RetireFields params={p} set={set} />
          )}
          {kind === "retire" && lineChecks("stopIncomeLineKeys", "income", "Income that stops (none ticked = all income)")}
          {kind === "income_change" && lineChecks("lineKeys", "income", "Which income (none ticked = all income)")}
          {kind === "buy_home" && lineChecks("stopLineKeys", "expense", "Lines that stop when you move in (usually rent)")}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => {
            // The cash-in select stores a string; the schema wants a boolean.
            if (kind === "new_loan" && typeof p.cashIn === "string") {
              const fixed = { ...draft, params: { ...p, cashIn: p.cashIn === "true" } };
              const parsed = eventSchema.safeParse({ ...fixed, updatedBy: "user" });
              if (!parsed.success) { setError("Check the values: some are missing or not valid."); return; }
              onSave(parsed.data);
              return;
            }
            save();
          }}>Save event</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Pension = { label?: string; amount: number; startMonth?: string; growthPct?: number | null };

/** Retire event fields: spending, pensions, contributions, withdrawals. */
function RetireFields({ params, set }: { params: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  const pensions = ((params.pensions as Pension[]) ?? []).slice();
  const w = (params.withdrawal ?? { method: "cover_shortfall" }) as { method: string; pct?: number; amount?: number; growWithInflation?: boolean };
  const setPension = (i: number, patch: Partial<Pension>) => {
    const next = pensions.map((x, k) => (k === i ? { ...x, ...patch } : x));
    set("pensions", next);
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="ev-spend">Spending in retirement, % of now</Label>
          <Input id="ev-spend" type="number" step="1" className="h-8" value={String(Math.round(Number(params.spendingFactor ?? 1) * 100))}
            onChange={(e) => set("spendingFactor", Number(e.target.value) / 100)} />
        </div>
        <label className="flex items-end gap-2 text-sm pb-1.5">
          <input type="checkbox" checked={params.stopContributions !== false} onChange={(e) => set("stopContributions", e.target.checked)} />
          Stop saving into investments
        </label>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Pensions and benefits (per month, in today&apos;s money)</Label>
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs" disabled={pensions.length >= 10}
            onClick={() => set("pensions", [...pensions, { label: "Pension", amount: 1000, growthPct: null }])}>+ Add</Button>
        </div>
        {pensions.length === 0 && <p className="text-xs text-muted-foreground">None. Add a workplace pension or a government benefit.</p>}
        {pensions.map((pen, i) => (
          <div key={i} className="grid grid-cols-[1fr_6rem_8rem_auto] gap-2 items-center">
            <Input aria-label={`Pension ${i + 1} name`} className="h-8" value={pen.label ?? ""} onChange={(e) => setPension(i, { label: e.target.value })} />
            <Input aria-label={`Pension ${i + 1} amount`} type="number" step="any" className="h-8" value={String(pen.amount ?? 0)} onChange={(e) => setPension(i, { amount: Number(e.target.value) })} />
            <Input aria-label={`Pension ${i + 1} starts`} type="month" className="h-8" value={pen.startMonth ?? ""} onChange={(e) => setPension(i, { startMonth: e.target.value || undefined })} />
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label={`Remove pension ${i + 1}`}
              onClick={() => set("pensions", pensions.filter((_, k) => k !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        ))}
        {pensions.length > 0 && <p className="text-xs text-muted-foreground">Start month blank = when you retire.</p>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1 col-span-2">
          <Label className="text-xs">Paying for retirement from investments</Label>
          <Select value={w.method} onValueChange={(v) => set("withdrawal",
            v === "fixed_pct" ? { method: "fixed_pct", pct: 4, growWithInflation: true }
            : v === "fixed_amount" ? { method: "fixed_amount", amount: 2000, growWithInflation: true }
            : { method: "cover_shortfall" })}>
            <SelectTrigger className="h-8 text-xs" aria-label="Withdrawal"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="cover_shortfall">Sell only what&apos;s needed to cover spending</SelectItem>
              <SelectItem value="fixed_pct">A fixed % a year (the 4% rule), growing with inflation</SelectItem>
              <SelectItem value="fixed_amount">A fixed amount every month</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {w.method === "fixed_pct" && (
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="ev-wpct">% of investments a year</Label>
            <Input id="ev-wpct" type="number" step="0.1" className="h-8" value={String(w.pct ?? 4)} onChange={(e) => set("withdrawal", { ...w, pct: Number(e.target.value) })} />
          </div>
        )}
        {w.method === "fixed_amount" && (
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="ev-wamt">Amount per month</Label>
            <Input id="ev-wamt" type="number" step="any" className="h-8" value={String(w.amount ?? 0)} onChange={(e) => set("withdrawal", { ...w, amount: Number(e.target.value) })} />
          </div>
        )}
      </div>
    </div>
  );
}
