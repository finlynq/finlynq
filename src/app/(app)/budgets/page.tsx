"use client";

/**
 * Budgets (Budget v2, plan/budget-v2.md): a cash-flow budget. Every income and
 * expense category is listed (budgeted or not), loans you repay on a schedule
 * are debt-payment lines, an expense group can be budgeted as one line, and
 * any spending line can roll its leftover into the next month. All numbers
 * come from GET /api/budgets/month.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Settings2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { OnboardingTips } from "@/components/onboarding-tips";
import { useDisplayCurrency } from "@/components/currency-provider";
import { getCurrentMonth, getMonthLabel } from "@/lib/currency";
import { shiftMonth } from "@/lib/budgets/lines";
import type { BudgetMonth } from "@/lib/budgets/month";
import { budgetApi } from "./_components/budget-api";
import { DebtSection, IncomeSection, SpendingSection, type BudgetFilter, type RowActions } from "./_components/budget-rows";
import { FillDialog, type FillScope } from "./_components/fill-dialog";
import { BudgetSettingsDialog } from "./_components/budget-settings-dialog";
import { CarryoverDialog } from "./_components/carryover-dialog";
import { MonthSummary } from "./_components/month-summary";

const COLLAPSED_KEY = "pf-budget-collapsed";

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export default function BudgetsPage() {
  const { displayCurrency } = useDisplayCurrency();
  const [month, setMonth] = useState(getCurrentMonth());
  const [data, setData] = useState<BudgetMonth | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<BudgetFilter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [fill, setFill] = useState<{ scope: FillScope; section: "spending" | "income" } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [carryTarget, setCarryTarget] = useState<{ key: string; name: string; carriedIn: number } | null>(null);
  const [groupToMerge, setGroupToMerge] = useState<{ group: string; label: string } | null>(null);
  const [merging, setMerging] = useState(false);
  const [ageOfMoney, setAgeOfMoney] = useState<number | null>(null);

  useEffect(() => setCollapsed(readCollapsed()), []);

  const reload = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        setData(await budgetApi.month(month));
        setLoadError(false);
      } catch {
        if (!quiet) setLoadError(true);
      } finally {
        setLoading(false);
      }
    },
    // displayCurrency: a currency switch re-reads the month in the new currency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [month, displayCurrency],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    fetch("/api/age-of-money")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && !d.error && typeof d.ageInDays === "number") setAgeOfMoney(d.ageInDays);
      })
      .catch(() => {});
  }, []);

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* per-viewer convenience only */
      }
      return next;
    });
  }

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setActionError("");
      try {
        await work();
        await reload(true);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Couldn't save");
      }
    },
    [reload],
  );

  const actions: RowActions = {
    setLine: async (key, amount) => {
      await budgetApi.setLine(key, month, amount);
      await reload(true);
    },
    categorySettings: (categoryId, patch) => void run(() => budgetApi.settings({ target: { categoryId }, month, ...patch })),
    groupSettings: (group, patch) => {
      if (patch.byGroup === true) {
        setGroupToMerge({ group, label: group || "Other" });
        return;
      }
      void run(() => budgetApi.settings({ target: { group }, month, ...patch }));
    },
    resetCarry: (key) => void run(() => budgetApi.carryover(key, month, 0)),
    editCarry: (key, name, carriedIn) => setCarryTarget({ key, name, carriedIn }),
    openFill: (scope, section) => setFill({ scope, section }),
    openSettings: () => setSettingsOpen(true),
  };

  async function confirmMerge() {
    if (!groupToMerge) return;
    setMerging(true);
    setActionError("");
    try {
      const res = await budgetApi.settings({ target: { group: groupToMerge.group }, month, byGroup: true });
      setNotice(
        res.movedBudgets
          ? `${groupToMerge.label} is now one budget line. ${res.movedBudgets} category budget${res.movedBudgets === 1 ? "" : "s"} from ${getMonthLabel(month)} on were added into it.`
          : `${groupToMerge.label} is now one budget line.`,
      );
      setGroupToMerge(null);
      await reload(true);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setMerging(false);
    }
  }

  if (loading && !data) return <PageSkeleton variant="list" rows={6} />;
  if (loadError || !data) {
    return (
      <ErrorState
        title="Couldn't load the budget"
        message="We couldn't load your budget. Please try again."
        onRetry={() => void reload()}
      />
    );
  }

  const cur = data.currency;
  const chips: Array<{ key: BudgetFilter; label: string; count?: number }> = [
    { key: "all", label: "All" },
    { key: "unbudgeted", label: "Not budgeted", count: data.counts.notBudgeted },
    { key: "over", label: "Overspent", count: data.counts.overspent },
    { key: "upcoming", label: "Due later", count: data.counts.withUpcoming },
  ];

  return (
    // Capped so names and amounts stay close together on very wide screens.
    <div className="max-w-6xl space-y-3">
      <OnboardingTips page="budgets" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Budgets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Plan the month&apos;s money in and out: income, spending and loan payments.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="mr-1 h-4 w-4" /> What counts
          </Button>
          <Button size="sm" onClick={() => setFill({ scope: { kind: "all", label: "all spending lines" }, section: "spending" })}>
            <Wand2 className="mr-1 h-4 w-4" /> Fill budgets
          </Button>
        </div>
      </div>

      <div className="inline-flex items-center gap-1 rounded-xl border bg-card px-1.5 py-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h2 className="min-w-28 text-center text-sm font-semibold">{getMonthLabel(month)}</h2>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        {month !== getCurrentMonth() && (
          <Button variant="ghost" size="sm" className="h-8" onClick={() => setMonth(getCurrentMonth())}>
            This month
          </Button>
        )}
      </div>

      <MonthSummary data={data} ageOfMoney={ageOfMoney} />

      {notice && (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          <span>{notice}</span>
          <button type="button" className="text-xs underline" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </div>
      )}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      <IncomeSection data={data} actions={actions} />
      <DebtSection data={data} actions={actions} />
      <SpendingSection
        data={data}
        filter={filter}
        collapsed={collapsed}
        onToggleGroup={toggleGroup}
        actions={actions}
        toolbar={
          // One row that scrolls sideways on phones instead of wrapping.
          <div
            className="flex max-w-full gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="group"
            aria-label="Show"
          >
            {chips.map((c) => {
              const active = filter === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setFilter(c.key)}
                  aria-pressed={active}
                  className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : c.count === 0
                        ? "text-muted-foreground/60 hover:text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {c.label}
                  {c.count != null && <span className="ml-1.5 font-mono tabular-nums">{c.count}</span>}
                </button>
              );
            })}
          </div>
        }
      />

      {data.excluded.length > 0 && (
        <button type="button" onClick={() => setSettingsOpen(true)} className="text-xs text-muted-foreground hover:underline">
          {data.excluded.length} categor{data.excluded.length === 1 ? "y is" : "ies are"} left out of the budget
        </button>
      )}

      {fill && (
        <FillDialog
          open={fill != null}
          onOpenChange={(o) => !o && setFill(null)}
          month={month}
          currency={cur}
          scope={fill.scope}
          section={fill.section}
          onDone={(n) => {
            setNotice(n ? `Saved ${n} budget${n === 1 ? "" : "s"}.` : "Nothing to fill.");
            void reload(true);
          }}
        />
      )}
      <BudgetSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        data={data}
        month={month}
        onChanged={() => void reload(true)}
      />
      <CarryoverDialog
        target={carryTarget}
        month={month}
        currency={cur}
        onClose={() => setCarryTarget(null)}
        onSaved={() => void reload(true)}
      />
      <ConfirmDialog
        open={groupToMerge != null}
        onOpenChange={(o) => !o && setGroupToMerge(null)}
        title={`Budget ${groupToMerge?.label ?? ""} as one line`}
        description={
          <>
            Its categories stop having budgets of their own; their spending adds up into one group budget. Category budgets
            from {getMonthLabel(month)} on are added together into the group&apos;s, and earlier months stay as they are.
          </>
        }
        confirmLabel="Budget as one line"
        busy={merging}
        onConfirm={confirmMerge}
      />
    </div>
  );
}
