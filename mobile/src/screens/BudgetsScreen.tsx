// Budgets (Budget v2): the month's money in and out, over the same
// GET /api/budgets/month the web page and the Left to spend widget read. Every
// income and expense category is listed, budgeted or not, as are debt payments
// and expense groups budgeted as one line.
//
// Rows are one or two short lines in one block (in-app feedback #26: rows were
// too tall for a long category list, and a category with no budget couldn't be
// seen). A row's other choices live in the sheet a tap opens. Budgeting a group
// as one line, how an account counts, setting a carried-in amount and the fuller
// Fill dialog stay on the web app.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import { leftToSpendSection } from "../lib/widgets/snapshot";
import { Icon } from "../components/icon";
import { BudgetLineSheet } from "../components/BudgetLineSheet";
import { BudgetFillSheet } from "../components/BudgetFillSheet";
import {
  BUDGET_COLLAPSED_KEY,
  BUDGET_ROUTE_MISSING,
  budgetRows,
  debtView,
  filterCounts,
  findBudgetTarget,
  formatMonthLabel,
  groupView,
  inGroupLineView,
  incomeLineView,
  isMissingRoute,
  leftToPlanView,
  monthProgress,
  sectionKey,
  spendingLineView,
  type BarSpec,
  type BudgetFilter,
  type BudgetMonth,
  type BudgetRow,
  type BudgetSettingsTarget,
  type DebtLine,
  type RowView,
} from "../lib/budgets";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Nav = NativeStackNavigationProp<MoreStackParamList, "Budgets">;

/**
 * "YYYY-MM" for the month `offset` months from `now`. Built from day 1 of the
 * month: `setMonth` on today's date overflows near month-end (Jan 31 + 1 month
 * = Mar 3), which made Next/Prev skip a month.
 */
export function monthFromOffset(offset: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function useToneColor() {
  const { colors } = useTheme();
  return (tone: RowView["tone"]) =>
    tone === "over" ? colors.destructive : tone === "warn" ? colors.primary : tone === "ok" ? colors.pos : colors.mutedForeground;
}

function Bar({ bar }: { bar: BarSpec }) {
  const { colors } = useTheme();
  const toneColor = useToneColor();
  const pct = Math.max(0, Math.min(100, (bar.value / bar.target) * 100));
  return (
    <View style={[styles.bar, { backgroundColor: colors.secondary }]}>
      <View style={[styles.barFill, { backgroundColor: toneColor(bar.tone), width: `${pct}%` }]} />
    </View>
  );
}

/** The totals the Left to spend widget shows, from its own function; then the rest of the month. */
function SummaryCard({ data }: { data: BudgetMonth }) {
  const { colors } = useTheme();
  const toneColor = useToneColor();
  const s = data.summary;
  const fmt = (n: number) => formatCurrency(n, data.currency);
  const left = leftToSpendSection(data, Date.now());
  const over = left.tone === "over";
  const progress = monthProgress(data.month, data.today);
  const plan = leftToPlanView(s);
  const showDebt = data.debt.length > 0 || s.plannedDebt > 0;
  const stat = (label: string, value: string) => (
    <View style={styles.statRow}>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.statValue, { color: colors.foreground }]}>{value}</Text>
    </View>
  );
  const ofPlanned = (actual: number, planned: number) => (planned > 0 ? `${fmt(actual)} of ${fmt(planned)}` : fmt(actual));

  return (
    <View style={[styles.summary, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
        {!left.hasBudget ? (progress.state === "current" ? "Spent this month" : "Spent") : over ? "Over budget" : "Left to spend"}
      </Text>
      <Text style={[styles.summaryValue, { color: left.hasBudget ? toneColor(left.tone) : colors.foreground }]}>
        {left.hasBudget ? left.leftLabel : left.spentLabel}
      </Text>
      {left.hasBudget ? (
        <>
          <Text style={[styles.summaryNote, { color: colors.foreground }]}>
            Spent {left.spentLabel} of {left.plannedLabel}
          </Text>
          <View style={styles.summaryBarWrap}>
            <View style={[styles.summaryBar, { backgroundColor: colors.secondary }]}>
              <View
                style={[
                  styles.summaryFill,
                  { backgroundColor: toneColor(left.tone), width: `${Math.min(left.usedFraction, 1) * 100}%` },
                ]}
              />
            </View>
            {progress.state === "current" ? (
              <View style={[styles.todayMark, { backgroundColor: colors.foreground, left: `${progress.fraction * 100}%` }]} />
            ) : null}
          </View>
          {progress.state === "current" ? (
            <Text style={[styles.summaryCaption, { color: colors.mutedForeground }]}>
              Day {progress.day} of {progress.days}; the mark is today
            </Text>
          ) : progress.state === "future" ? (
            <Text style={[styles.summaryCaption, { color: colors.mutedForeground }]}>This month hasn't started</Text>
          ) : null}
        </>
      ) : (
        <Text style={[styles.summaryCaption, { color: colors.mutedForeground }]}>No spending budgets for {formatMonthLabel(data.month)} yet.</Text>
      )}

      <View style={[styles.summaryBlock, { borderTopColor: colors.border }]}>
        <View style={styles.statRow}>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{plan.label}</Text>
          {plan.amount != null ? (
            <Text style={[styles.statValue, { color: toneColor(plan.tone ?? "muted") }]}>{fmt(plan.amount)}</Text>
          ) : null}
        </View>
        <Text style={[styles.summaryCaption, { color: colors.mutedForeground }]}>{plan.sentence(fmt)}</Text>
        {stat("Income received", ofPlanned(s.receivedIncome, s.plannedIncome))}
        {showDebt ? stat("Debt paid", ofPlanned(s.paidDebt, s.plannedDebt)) : null}
        {stat("Net so far", `${s.netCashFlow > 0.005 ? "+" : ""}${fmt(s.netCashFlow)}`)}
        {s.upcoming > 0.005 ? stat("Still due this month", fmt(s.upcoming)) : null}
      </View>
    </View>
  );
}

/** Name and right-hand figure, then the amounts and a bar on one line under them. */
function RowLines({
  name,
  view,
  nameStyle,
  badge,
  leading,
}: {
  name: string;
  view: RowView;
  nameStyle?: object;
  badge?: React.ReactNode;
  leading?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const toneColor = useToneColor();
  return (
    <>
      <View style={styles.rowLine}>
        {leading}
        <Text style={[styles.rowName, { color: colors.foreground }, nameStyle]} numberOfLines={1}>
          {name}
        </Text>
        {badge}
        {view.right ? <Text style={[styles.rowRight, { color: toneColor(view.tone) }]}>{view.right}</Text> : null}
      </View>
      {view.meta || view.bar ? (
        <View style={styles.rowLine}>
          {view.meta ? (
            <Text style={[styles.rowMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
              {view.meta}
            </Text>
          ) : null}
          {view.bar ? <Bar bar={view.bar} /> : null}
        </View>
      ) : null}
    </>
  );
}

export default function BudgetsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();
  const isFocused = useIsFocused();

  const [data, setData] = useState<BudgetMonth | null>(null);
  // The month `data` belongs to. Rows only render under a matching month label,
  // so a slow or failed fetch never shows another month's rows.
  const [loadedMonth, setLoadedMonth] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [monthOffset, setMonthOffset] = useState(0);
  const [filter, setFilter] = useState<BudgetFilter>("all");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [excludedOpen, setExcludedOpen] = useState(false);
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [fillOpen, setFillOpen] = useState(false);

  const month = monthFromOffset(monthOffset);
  const monthRef = useRef(month);
  monthRef.current = month;
  const loadedMonthRef = useRef<string | null>(null);

  // A failed fetch for a different month must not leave the previous month's
  // rows on screen under the new label. A failed refresh of the SAME month
  // keeps what is already shown and just surfaces the error.
  const failMonth = useCallback((target: string, message: string) => {
    if (loadedMonthRef.current !== target) {
      setData(null);
      loadedMonthRef.current = target;
      setLoadedMonth(target);
    }
    setError(message);
  }, []);

  const fetchMonth = useCallback(
    async (isRefresh = false) => {
      const target = month;
      if (isRefresh) setRefreshing(true);
      try {
        const res = await endpoints.getBudgetMonth(target);
        // The user moved to another month while this was in flight; the newer
        // fetch owns the screen.
        if (monthRef.current !== target) return;
        if (res.success && res.data) {
          setData(res.data);
          loadedMonthRef.current = target;
          setLoadedMonth(target);
          setError(null);
        } else {
          const message = res.success ? "Couldn't load the budget" : res.error;
          logger.warn("budgets", "month fetch failed", { error: message });
          failMonth(target, isMissingRoute(message) ? BUDGET_ROUTE_MISSING : message);
        }
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("budgets", "fetch threw", { detail });
        if (monthRef.current === target) failMonth(target, "Cannot connect to server");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [month, failMonth],
  );

  // Refetch on focus (back from a category or a loan) and whenever the month changes.
  useEffect(() => {
    if (isFocused) fetchMonth();
  }, [isFocused, fetchMonth]);

  useEffect(() => {
    AsyncStorage.getItem(BUDGET_COLLAPSED_KEY)
      .then((raw) => {
        if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
      })
      .catch(() => {});
  }, []);

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      void AsyncStorage.setItem(BUDGET_COLLAPSED_KEY, JSON.stringify([...next])).catch(() => {});
      return next;
    });
  };

  const goToMonth = (next: number) => {
    setSheetKey(null);
    setFillOpen(false);
    setNotice(null);
    setMonthOffset(next);
  };

  const monthLoading = loadedMonth !== month;
  const shown = monthLoading ? null : data;
  const currency = shown?.currency ?? "";

  const rows = useMemo<BudgetRow[]>(
    () => (shown ? budgetRows(shown, filter, collapsed, excludedOpen) : []),
    [shown, filter, collapsed, excludedOpen],
  );
  const counts = shown ? filterCounts(shown) : null;
  const sheetTarget = shown && sheetKey ? findBudgetTarget(shown, sheetKey) : null;

  const openDebt = async (d: DebtLine) => {
    if (d.loanIds.length === 1) {
      const res = await endpoints.getLoans().catch(() => null);
      const loan = res?.success ? res.data?.find((l) => l.id === d.loanIds[0]) : undefined;
      // A loan the server could not schedule has no schedule to open.
      if (loan && loan.remainingBalance != null) {
        navigation.navigate("LoanDetail", { loan });
        return;
      }
    }
    navigation.navigate("Loans");
  };

  const bringBack = async (target: BudgetSettingsTarget) => {
    setError(null);
    try {
      const res = await endpoints.setBudgetSettings({ target, month, excluded: false });
      if (!res.success) {
        setError(res.error || "Couldn't save. Please try again.");
        return;
      }
      await fetchMonth();
    } catch {
      setError("Cannot connect to server");
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const blockStyle = (first: boolean, last: boolean) => [
    styles.row,
    { backgroundColor: colors.card, borderColor: colors.border },
    first && styles.rowFirst,
    last && styles.rowLast,
  ];

  const renderRow = (row: BudgetRow) => {
    switch (row.kind) {
      case "summary":
        return shown ? (
          <>
            <SummaryCard data={shown} />
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>Tap a line to set its budget.</Text>
          </>
        ) : null;
      case "section": {
        const key = sectionKey(row.section);
        return (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${row.title}${row.collapsible ? (row.collapsed ? ", show" : ", hide") : ""}`}
            activeOpacity={0.7}
            onPress={row.collapsible ? () => toggleCollapsed(key) : undefined}
            style={styles.sectionHeader}
          >
            {row.collapsible ? (
              <Icon name={row.collapsed ? "chevronRight" : "chevronDown"} size={15} color={colors.mutedForeground} />
            ) : null}
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{row.title}</Text>
            <Text style={[styles.sectionAmounts, { color: colors.mutedForeground }]}>
              {row.planned > 0
                ? `${formatCurrency(row.actual, currency)} of ${formatCurrency(row.planned, currency)}`
                : formatCurrency(row.actual, currency)}
            </Text>
          </TouchableOpacity>
        );
      }
      case "group": {
        const { group } = row;
        const count = group.lines.length;
        const base = groupView(group, row.section, currency);
        const view: RowView = row.collapsed
          ? { ...base, meta: [base.meta, `${count} ${count === 1 ? "category" : "categories"}`].filter(Boolean).join(" · ") }
          : base;
        const toggle = row.collapsible ? () => toggleCollapsed(group.key) : undefined;
        return (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={group.byGroup ? `Budget for the ${group.name} group` : `${group.name} group`}
            activeOpacity={0.7}
            onPress={group.byGroup ? () => setSheetKey(group.key) : toggle}
            style={[blockStyle(row.first, row.last), { backgroundColor: colors.muted }]}
          >
            <RowLines
              name={group.name}
              view={view}
              nameStyle={styles.groupName}
              leading={
                row.collapsible ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={row.collapsed ? `Show ${group.name}` : `Hide ${group.name}`}
                    hitSlop={10}
                    onPress={toggle}
                    style={styles.chevron}
                  >
                    <Icon name={row.collapsed ? "chevronRight" : "chevronDown"} size={15} color={colors.mutedForeground} />
                  </TouchableOpacity>
                ) : null
              }
              badge={
                <>
                  {group.byGroup ? (
                    <Text style={[styles.badge, { color: colors.primary, borderColor: colors.primary }]}>One budget</Text>
                  ) : null}
                  {group.rollover ? (
                    <View style={styles.rollIcon}>
                      <Icon name="refresh" size={12} color={colors.mutedForeground} />
                    </View>
                  ) : null}
                  {group.byGroup && group.plan?.ruleCount ? (
                    <View style={styles.rollIcon} accessibilityLabel="Has budget rules">
                      <Icon name="rules" size={12} color={colors.mutedForeground} />
                    </View>
                  ) : null}
                </>
              }
            />
          </TouchableOpacity>
        );
      }
      case "line": {
        const { line } = row;
        const view =
          row.section === "income"
            ? incomeLineView(line, currency)
            : row.inGroupBudget
              ? inGroupLineView(line, currency)
              : spendingLineView(line, currency);
        const name = safeName(line.name);
        return (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={row.inGroupBudget ? name : `${row.section === "income" ? "Expected income from" : "Budget for"} ${name}`}
            activeOpacity={0.7}
            onPress={() => setSheetKey(line.key)}
            style={[blockStyle(row.first, row.last), styles.lineRow]}
          >
            <RowLines
              name={name}
              view={view}
              badge={
                <>
                  {line.rollover ? (
                    <View style={styles.rollIcon}>
                      <Icon name="refresh" size={12} color={colors.mutedForeground} />
                    </View>
                  ) : null}
                  {!row.inGroupBudget && line.plan?.ruleCount ? (
                    <View style={styles.rollIcon} accessibilityLabel="Has budget rules">
                      <Icon name="rules" size={12} color={colors.mutedForeground} />
                    </View>
                  ) : null}
                </>
              }
            />
          </TouchableOpacity>
        );
      }
      case "debt": {
        const { debt } = row;
        const tappable = debt.loanIds.length > 0;
        return (
          <TouchableOpacity
            accessibilityRole={tappable ? "button" : undefined}
            accessibilityLabel={tappable ? `${safeName(debt.name)} loan` : safeName(debt.name)}
            activeOpacity={tappable ? 0.7 : 1}
            onPress={tappable ? () => void openDebt(debt) : undefined}
            style={blockStyle(row.first, row.last)}
          >
            <RowLines name={safeName(debt.name)} view={debtView(debt, shown?.today ?? "", currency)} />
          </TouchableOpacity>
        );
      }
      case "debtNote":
        return (
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            A payment's interest is part of its line here, not counted again under its expense category.
          </Text>
        );
      case "excludedToggle":
        return (
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.7}
            onPress={() => setExcludedOpen((v) => !v)}
            style={styles.excludedToggle}
          >
            <Text style={[styles.excludedToggleText, { color: colors.mutedForeground }]}>
              {row.open ? "Hide" : "Show"} {row.count} {row.count === 1 ? "category" : "categories"} left out of the budget
            </Text>
          </TouchableOpacity>
        );
      case "excluded":
        return (
          <View style={blockStyle(row.first, row.last)}>
            <View style={styles.rowLine}>
              <Text style={[styles.rowName, { color: colors.foreground }]} numberOfLines={1}>
                {row.item.label}
              </Text>
              <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>{row.item.note}</Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Bring back ${row.item.label}`}
                hitSlop={8}
                onPress={() => void bringBack(row.item.target)}
                style={styles.bringBack}
              >
                <Text style={[styles.bringBackText, { color: colors.primary }]}>Bring back</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      case "empty":
        return <Text style={[styles.empty, { color: colors.mutedForeground }]}>{row.message}</Text>;
    }
  };

  const chips: Array<{ key: BudgetFilter; label: string; count?: number }> = [
    { key: "all", label: "All" },
    { key: "unbudgeted", label: "Not budgeted", count: counts?.unbudgeted },
    { key: "over", label: "Overspent", count: counts?.over },
    { key: "upcoming", label: "Due later", count: counts?.upcoming },
  ];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Budgets</Text>
        {shown ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Fill budgets"
            style={[styles.fillBtn, { borderColor: colors.border }]}
            onPress={() => setFillOpen(true)}
          >
            <Text style={[styles.fillText, { color: colors.primary }]}>Fill</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.monthNav}>
        <TouchableOpacity accessibilityRole="button" hitSlop={8} onPress={() => goToMonth(monthOffset - 1)}>
          <Text style={[styles.navBtn, { color: colors.primary }]}>← Prev</Text>
        </TouchableOpacity>
        <View style={styles.monthCenter}>
          <Text style={[styles.monthLabel, { color: colors.foreground }]}>{formatMonthLabel(month)}</Text>
          {monthOffset !== 0 ? (
            <TouchableOpacity accessibilityRole="button" hitSlop={6} onPress={() => goToMonth(0)}>
              <Text style={[styles.thisMonth, { color: colors.primary }]}>This month</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity accessibilityRole="button" hitSlop={8} onPress={() => goToMonth(monthOffset + 1)}>
          <Text style={[styles.navBtn, { color: colors.primary }]}>Next →</Text>
        </TouchableOpacity>
      </View>

      {shown ? (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {chips.map((c) => {
              const active = filter === c.key;
              return (
                <TouchableOpacity
                  key={c.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={c.count != null ? `${c.label}: ${c.count}` : c.label}
                  onPress={() => setFilter(c.key)}
                  style={[
                    styles.chip,
                    active
                      ? { backgroundColor: colors.primary, borderColor: colors.primary }
                      : { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.chipText, { color: active ? colors.primaryForeground : colors.foreground }]}>
                    {c.label}
                    {c.count != null ? ` ${c.count}` : ""}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {notice ? <Text style={[styles.notice, { color: colors.pos }]}>{notice}</Text> : null}
      {error && shown ? <Text style={[styles.banner, { color: colors.destructive }]}>{error}</Text> : null}

      <FlatList
        data={rows}
        keyExtractor={(row) => {
          switch (row.kind) {
            case "section":
              return sectionKey(row.section);
            case "group":
              return `group-${row.group.key}`;
            case "line":
              return row.line.key;
            case "debt":
              return `debt-${row.debt.accountId}`;
            case "excluded":
              return `out-${row.item.key}`;
            default:
              return row.kind;
          }
        }}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchMonth(true)} />}
        renderItem={({ item }) => renderRow(item)}
        ListEmptyComponent={
          monthLoading ? (
            <View style={styles.monthLoading}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : (
            <Text style={[styles.empty, { color: colors.destructive }]}>{error ?? "Couldn't load the budget"}</Text>
          )
        }
      />

      <BudgetLineSheet
        target={sheetTarget}
        month={month}
        currency={currency}
        onClose={() => setSheetKey(null)}
        onChanged={() => fetchMonth()}
        onSeeSpending={(categoryId, name) => {
          setSheetKey(null);
          navigation.navigate("CategoryDetail", { categoryId, name });
        }}
        onOpenRules={(lineKey, name) => {
          setSheetKey(null);
          navigation.navigate("BudgetRules", { lineKey, name, month });
        }}
      />
      <BudgetFillSheet
        visible={fillOpen && shown != null}
        month={month}
        currency={currency}
        onClose={() => setFillOpen(false)}
        onSaved={async (count) => {
          setNotice(count ? `Saved ${count} ${count === 1 ? "budget" : "budgets"}.` : "Nothing to fill.");
          await fetchMonth();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  header: { fontSize: 28, fontWeight: "800" },
  fillBtn: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  fillText: { fontSize: 14, fontWeight: "700" },
  monthNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  monthCenter: { alignItems: "center" },
  navBtn: { fontSize: 14, fontWeight: "600" },
  monthLabel: { fontSize: 16, fontWeight: "700" },
  thisMonth: { fontSize: 12, fontWeight: "600", marginTop: 1 },
  chips: { paddingHorizontal: 16, paddingBottom: 8 },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
  },
  chipText: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  notice: { fontSize: 13, paddingHorizontal: 16, paddingBottom: 6 },
  banner: { fontSize: 13, paddingHorizontal: 16, paddingBottom: 6 },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  monthLoading: { paddingVertical: 24, alignItems: "center" },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 11, lineHeight: 16, marginBottom: 8 },
  summary: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 6 },
  summaryLabel: { fontSize: 12, fontWeight: "600" },
  summaryValue: { fontSize: 26, fontWeight: "800", marginTop: 1, fontVariant: ["tabular-nums"] },
  summaryNote: { fontSize: 13, marginTop: 2, fontVariant: ["tabular-nums"] },
  summaryBarWrap: { marginTop: 8, height: 8, justifyContent: "center" },
  summaryBar: { height: 6, borderRadius: 3, overflow: "hidden" },
  summaryFill: { height: 6, borderRadius: 3 },
  todayMark: { position: "absolute", top: -2, bottom: -2, width: 2, borderRadius: 1, marginLeft: -1 },
  summaryCaption: { fontSize: 11, lineHeight: 15, marginTop: 4 },
  summaryBlock: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 10, paddingTop: 8 },
  statRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: 3 },
  statLabel: { fontSize: 13 },
  statValue: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  sectionHeader: { flexDirection: "row", alignItems: "center", paddingVertical: 8, marginTop: 2 },
  sectionTitle: { flex: 1, fontSize: 15, fontWeight: "700", marginLeft: 4 },
  sectionAmounts: { fontSize: 12, fontVariant: ["tabular-nums"] },
  // Rows sit edge to edge in one bordered block; the first and last round its
  // corners.
  row: {
    minHeight: 40,
    justifyContent: "center",
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  rowLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12, marginBottom: 8 },
  lineRow: { paddingLeft: 16 },
  rowLine: { flexDirection: "row", alignItems: "center" },
  rowName: { flexShrink: 1, flexGrow: 1, fontSize: 14, fontWeight: "500", marginRight: 6 },
  groupName: { fontWeight: "700" },
  rowRight: { flexShrink: 0, fontSize: 13, fontWeight: "700", marginLeft: "auto", fontVariant: ["tabular-nums"] },
  rowMeta: { flexShrink: 1, fontSize: 12, marginTop: 1, fontVariant: ["tabular-nums"] },
  chevron: { marginRight: 4 },
  rollIcon: { marginRight: 6 },
  badge: {
    fontSize: 10,
    fontWeight: "700",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: 4,
    marginRight: 6,
  },
  bar: { flex: 1, minWidth: 36, height: 4, borderRadius: 2, overflow: "hidden", marginLeft: 8, marginTop: 1 },
  barFill: { height: 4, borderRadius: 2 },
  excludedToggle: { paddingVertical: 10, alignItems: "center" },
  excludedToggleText: { fontSize: 13, fontWeight: "600" },
  bringBack: { marginLeft: 10 },
  bringBackText: { fontSize: 13, fontWeight: "700" },
});
