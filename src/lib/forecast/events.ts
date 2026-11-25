/**
 * Events (plan/forecast-scenarios.md section 6), expanded at run time into
 * what the two stages understand. Pure, client-safe.
 *
 *  one_off          → a one-month line in the "Events" group (income or expense)
 *  recurring_item   → a monthly line from `month` to `to`, optional growth
 *  income_change    → a generated manual layer (scale / set) on income lines
 *  move_money       → cash ↔ investments transfers (not income or spending)
 *  extra_debt_payment, refinance, debt_strategy → loan changes for simulate
 *  new_loan         → a scenario loan (+ cash in, when the money lands in cash)
 *  buy_home         → down payment (cash → asset), the home as an asset, a new
 *                     mortgage, a yearly-costs line, and the chosen lines (rent)
 *                     set to 0 from the purchase month
 * Lines an event adds are not touched by layers: their amounts are the event's.
 */
import { layerSchema, type ForecastEvent, type ForecastLayer, type ScenarioConfig } from "./config";
import type { ForecastLineDef } from "./types";

export type NewLoanPlan = {
  key: string;
  label: string;
  principal: number;
  annualRatePct: number;
  termMonths: number;
  startIdx: number;
  cashIn: boolean;
};

export type LoanPlan = {
  /** Extra payment per month index, per loan key. */
  extras: Map<string, number[]>;
  refinances: Map<string, { idx: number; annualRatePct: number; termMonths: number; label: string }>;
  newLoans: NewLoanPlan[];
  strategy: { method: "snowball" | "avalanche"; extraPerMonth: number; startIdx: number; label: string } | null;
};

export type ExpandedEvents = {
  lines: ForecastLineDef[];
  amounts: Map<string, Array<number | null>>;
  layers: ForecastLayer[];
  toInvestments: number[];
  purchases: number[];
  assetAdds: number[];
  loanPlan: LoanPlan;
  warnings: Array<{ code: string; message: string; ref?: string }>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function idxOf(months: readonly string[], month: string): number {
  const i = months.indexOf(month);
  if (i >= 0) return i;
  if (months.length && month < months[0]) return 0; // started before the forecast: applies from the start
  return -1; // after the horizon
}

function toIdx(months: readonly string[], to: string | undefined): number {
  if (!to) return months.length - 1;
  const i = months.indexOf(to);
  if (i >= 0) return i;
  return to < months[0] ? -1 : months.length - 1;
}

export function expandEvents(config: ScenarioConfig, months: readonly string[], loanKeys: ReadonlySet<string>): ExpandedEvents {
  const n = months.length;
  const out: ExpandedEvents = {
    lines: [],
    amounts: new Map(),
    layers: [],
    toInvestments: new Array(n).fill(0),
    purchases: new Array(n).fill(0),
    assetAdds: new Array(n).fill(0),
    loanPlan: { extras: new Map(), refinances: new Map(), newLoans: [], strategy: null },
    warnings: [],
  };
  const events = (config.events ?? []).filter((e) => e.enabled);
  // New loans first, so other events can point at them.
  const allLoanKeys = new Set(loanKeys);
  for (const e of events) if (e.kind === "new_loan") allLoanKeys.add(`newloan:${e.id}`);
  for (const e of events) if (e.kind === "buy_home") allLoanKeys.add(`newloan:${e.id}`);

  const label = (e: ForecastEvent, fallback: string) => e.label || fallback;
  const addLine = (key: string, name: string, type: "income" | "expense", amounts: Array<number | null>) => {
    out.lines.push({ key, label: name, type, group: "Events" });
    out.amounts.set(key, amounts);
  };

  for (const e of events) {
    const start = idxOf(months, e.month);
    if (start < 0) continue; // starts after the horizon
    switch (e.kind) {
      case "one_off": {
        const a: Array<number | null> = new Array(n).fill(null);
        a[start] = e.params.amount;
        addLine(`ev:${e.id}`, label(e, e.params.direction === "in" ? "One-off income" : "One-off expense"), e.params.direction === "in" ? "income" : "expense", a);
        break;
      }
      case "recurring_item": {
        const end = toIdx(months, e.params.to);
        const rate = (e.params.growthPct ?? config.assumptions.inflationPct) / 100;
        const a: Array<number | null> = months.map((_, i) =>
          i >= start && i <= end ? round2(e.params.amount * Math.pow(1 + rate, (i - start) / 12)) : null,
        );
        addLine(`ev:${e.id}`, label(e, e.params.type === "income" ? "New income" : "New expense"), e.params.type, a);
        break;
      }
      case "income_change": {
        out.layers.push(
          layerSchema.parse({
            id: `event-${e.id}`,
            kind: "manual",
            label: label(e, "Income change"),
            op: e.params.op,
            params: { amount: e.params.value },
            scope: e.params.lineKeys.length ? { lineKeys: e.params.lineKeys } : { lineTypes: ["income"] },
            from: months[start],
            ...(e.params.to ? { to: e.params.to } : {}),
            updatedBy: e.updatedBy,
          }),
        );
        break;
      }
      case "move_money": {
        const sign = e.params.direction === "to_investments" ? 1 : -1;
        const end = e.params.frequency === "once" ? start : toIdx(months, e.params.to);
        for (let i = start; i <= end; i++) out.toInvestments[i] += sign * e.params.amount;
        break;
      }
      case "extra_debt_payment": {
        if (!allLoanKeys.has(e.params.loanKey)) {
          out.warnings.push({ code: "event_unknown_loan", message: `${label(e, "Extra payment")}: that loan isn't in this forecast.`, ref: e.id });
          break;
        }
        const arr = out.loanPlan.extras.get(e.params.loanKey) ?? new Array(n).fill(0);
        const end = e.params.frequency === "once" ? start : toIdx(months, e.params.to);
        for (let i = start; i <= end; i++) arr[i] += e.params.amount;
        out.loanPlan.extras.set(e.params.loanKey, arr);
        break;
      }
      case "refinance": {
        if (!allLoanKeys.has(e.params.loanKey)) {
          out.warnings.push({ code: "event_unknown_loan", message: `${label(e, "Refinance")}: that loan isn't in this forecast.`, ref: e.id });
          break;
        }
        out.loanPlan.refinances.set(e.params.loanKey, { idx: start, annualRatePct: e.params.annualRatePct, termMonths: e.params.termMonths, label: label(e, "Refinance") });
        break;
      }
      case "new_loan": {
        out.loanPlan.newLoans.push({
          key: `newloan:${e.id}`, label: label(e, "New loan"), principal: e.params.principal,
          annualRatePct: e.params.annualRatePct, termMonths: e.params.termMonths, startIdx: start, cashIn: e.params.cashIn,
        });
        break;
      }
      case "buy_home": {
        const p = e.params;
        const down = Math.min(p.downPayment, p.price);
        out.purchases[start] += down;
        out.assetAdds[start] += p.price;
        if (p.price - down > 0.005) {
          out.loanPlan.newLoans.push({
            key: `newloan:${e.id}`, label: `${label(e, "Home")}: mortgage`, principal: round2(p.price - down),
            annualRatePct: p.mortgageRatePct, termMonths: p.mortgageTermMonths, startIdx: start, cashIn: false,
          });
        }
        if (p.yearlyCostsPct > 0) {
          const rate = config.assumptions.inflationPct / 100;
          const monthly = (p.price * p.yearlyCostsPct) / 100 / 12;
          addLine(`ev:${e.id}:costs`, `${label(e, "Home")}: tax, insurance, upkeep`, "expense",
            months.map((_, i) => (i >= start ? round2(monthly * Math.pow(1 + rate, (i - start) / 12)) : null)));
        }
        if (p.stopLineKeys.length) {
          out.layers.push(layerSchema.parse({
            id: `event-${e.id}-stop`, kind: "manual", label: `${label(e, "Home")}: stops`, op: "set",
            params: { amount: 0 }, scope: { lineKeys: p.stopLineKeys }, from: months[start], updatedBy: e.updatedBy,
          }));
        }
        break;
      }
      case "debt_strategy": {
        if (out.loanPlan.strategy) {
          out.warnings.push({ code: "event_two_strategies", message: "Only the first debt strategy is used.", ref: e.id });
          break;
        }
        out.loanPlan.strategy = { method: e.params.method, extraPerMonth: e.params.extraPerMonth, startIdx: start, label: label(e, "Debt strategy") };
        break;
      }
    }
  }
  return out;
}

/** Monthly payment that pays `principal` off over `months` at `annualRatePct` (annuity). */
export function annuityPayment(principal: number, annualRatePct: number, months: number): number {
  const r = annualRatePct / 100 / 12;
  if (months <= 0) return principal;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - Math.pow(1 + r, -months));
}
