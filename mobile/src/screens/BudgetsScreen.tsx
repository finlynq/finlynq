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
//
// Layout per FINLYNQ-318 (owner-approved mockup, 2026-11-14): whole amounts
// only, the currency named once under the month ("All amounts in CAD") with a
// bare $ on amounts, a hero card with the pace through the month, the rest of
// the month as a 2×2 grid, short section totals with a % chip, "Almost spent"
// at 95%, and a "+ Set budget" button on lines with no budget. Cents stay in
// the set-budget sheet and the transaction views.

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
import { formatCompactMoney, formatWholeMoney, safeName } from "../lib/format";
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
  ALMOST_SPENT_AT,
  groupView,
  hasAnyBudget,
  inGroupLineView,
  incomeLineView,
  isMissingRoute,
  leftToPlanView,
  monthProgress,
  percentOf,
  sectionKey,
  spendingLineView,
  spendingPace,
  type BarSpec,
  type BudgetFilter,
  type BudgetMonth,
  type BudgetRow,
  type BudgetSection,
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

type Tone = RowView["tone"] | "info";

function useToneColor() {
  const { colors } = useTheme();
  return (tone: Tone) =>
    tone === "over"
      ? colors.destructive
      : tone === "warn"
        ? colors.primary
        : tone === "ok"
          ? colors.pos
          : tone === "info"
            ? colors.chart4
            : colors.mutedForeground;
}

/** A 6-digit hex colour at 12% opacity: the fill behind a chip. */
const tint = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? `${hex}1F` : "transparent");

/** A small rounded label in a tone's colour on a faint fill of it. */
function Chip({ label, tone, size = "sm" }: { label: string; tone: Tone; size?: "sm" | "md" }) {
  const toneColor = useToneColor();
  const color = toneColor(tone);
  return (
    <Text style={[size === "md" ? styles.chipMd : styles.chipSm, { color, backgroundColor: tint(color) }]} numberOfLines={1}>
      {label}
    </Text>
  );
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

/** A thin bar for a summary tile: `fraction` of it filled, 0..1. */
function MiniBar({ fraction, tone }: { fraction: number; tone: Tone }) {
  const { colors } = useTheme();
  const toneColor = useToneColor();
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <View style={[styles.miniBar, { backgroundColor: colors.secondary }]}>
      <View style={[styles.miniBarFill, { backgroundColor: toneColor(tone), width: `${pct}%` }]} />
    </View>
  );
}

/**
 * Left to spend, from the Left to spend widget's own function (so the screen
 * and the widget read one sum), with the month's pace and what is still due.
 */
function HeroCard({ data, fmt }: { data: BudgetMonth; fmt: (n: number) => string }) {
  const { colors } = useTheme();
  const toneColor = useToneColor();
  const s = data.summary;
  const left = leftToSpendSection(data, Date.now(), fmt);
  const over = left.tone === "over";
  const progress = monthProgress(data.month, data.today);
  const pace = spendingPace(s.plannedSpending, s.spent, progress, fmt);
  const bills = data.counts.withUpcoming;

  return (
    <View style={[styles.hero, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.heroLabel, { color: colors.mutedForeground }]}>
        {!left.hasBudget ? (progress.state === "current" ? "Spent this month" : "Spent") : over ? "Over budget" : "Left to spend"}
      </Text>
      <Text
        style={[styles.heroValue, { color: left.hasBudget ? toneColor(left.tone) : colors.foreground }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {left.hasBudget ? left.leftLabel : left.spentLabel}
      </Text>
      {left.hasBudget ? (
        <>
          <Text style={[styles.heroNote, { color: colors.foreground }]}>
            Spent {left.spentLabel} of {left.plannedLabel}
          </Text>
          <View style={styles.heroBarWrap}>
            <View style={[styles.heroBar, { backgroundColor: colors.secondary }]}>
              <View
                style={[
                  styles.heroFill,
                  { backgroundColor: toneColor(left.tone), width: `${Math.min(left.usedFraction, 1) * 100}%` },
                ]}
              />
            </View>
            {progress.state === "current" ? (
              <View
                accessibilityLabel="Today"
                style={[styles.todayMark, { backgroundColor: colors.foreground, left: `${progress.fraction * 100}%` }]}
              />
            ) : null}
          </View>
          {progress.state === "current" ? (
            <View style={styles.heroPaceRow}>
              <Text style={[styles.heroCaption, { color: colors.mutedForeground }]}>
                Day {progress.day} of {progress.days}
              </Text>
              {pace ? <Chip label={pace.label} tone={pace.tone} size="md" /> : null}
            </View>
          ) : progress.state === "future" ? (
            <Text style={[styles.heroCaption, { color: colors.mutedForeground }]}>This month hasn't started</Text>
          ) : null}
        </>
      ) : (
        <Text style={[styles.heroCaption, { color: colors.mutedForeground }]}>
          No spending budgets for {formatMonthLabel(data.month)} yet.
        </Text>
      )}
      {s.upcoming > 0.005 ? (
        <>
          <View style={[styles.heroDivider, { backgroundColor: colors.border }]} />
          <View style={styles.heroDueRow}>
            <Text style={[styles.heroDueLabel, { color: colors.foreground }]}>Still due this month</Text>
            <Text style={[styles.heroDueValue, { color: colors.foreground }]}>
              {fmt(s.upcoming)}
              {bills > 0 ? (
                <Text style={{ color: colors.mutedForeground, fontWeight: "500" }}>
                  {` · ${bills} ${bills === 1 ? "bill" : "bills"}`}
                </Text>
              ) : null}
            </Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

function Tile({
  label,
  value,
  valueTone,
  caption,
  chip,
  bar,
}: {
  label: string;
  value: string;
  valueTone: Tone | "plain";
  caption: string;
  chip?: { label: string; tone: Tone } | null;
  bar?: { fraction: number; tone: Tone } | null;
}) {
  const { colors } = useTheme();
  const toneColor = useToneColor();
  return (
    <View style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.tileHead}>
        <Text style={[styles.tileLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
          {label}
        </Text>
        {chip ? <Chip label={chip.label} tone={chip.tone} /> : null}
      </View>
      <Text
        style={[styles.tileValue, { color: valueTone === "plain" ? colors.foreground : toneColor(valueTone) }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text style={[styles.tileCaption, { color: colors.mutedForeground }]} numberOfLines={2}>
        {caption}
      </Text>
      {bar ? <MiniBar fraction={bar.fraction} tone={bar.tone} /> : null}
    </View>
  );
}

/** The rest of the month as a 2×2 grid: left to plan, net so far, income, debt paid. */
function SummaryGrid({ data, fmt }: { data: BudgetMonth; fmt: (n: number) => string }) {
  const s = data.summary;
  const plan = leftToPlanView(s);
  const showDebt = data.debt.length > 0 || s.plannedDebt > 0;
  const incomePct = percentOf(s.receivedIncome, s.plannedIncome);
  const debtPct = percentOf(s.paidDebt, s.plannedDebt);
  const net = s.netCashFlow;

  const tiles: Array<React.ComponentProps<typeof Tile> & { key: string }> = [
    {
      key: "plan",
      label: plan.label,
      value: plan.amount != null ? fmt(plan.amount) : "—",
      valueTone: plan.tone ?? "muted",
      caption: s.plannedIncome > 0.005 ? `of ${fmt(s.plannedIncome)} expected` : "No expected income set",
      bar:
        plan.amount != null && s.plannedIncome > 0.005
          ? { fraction: plan.tone === "over" ? 1 : plan.amount / s.plannedIncome, tone: plan.tone ?? "ok" }
          : null,
    },
    {
      key: "net",
      label: "Net so far",
      value: `${net > 0.005 ? "+" : ""}${fmt(net)}`,
      valueTone: net > 0.005 ? "ok" : net < -0.005 ? "over" : "plain",
      caption: "income − debt − spending",
    },
    {
      key: "income",
      label: "Income",
      value: fmt(s.receivedIncome),
      valueTone: "plain",
      caption: incomePct != null ? `${incomePct}% of ${fmt(s.plannedIncome)}` : "received",
      chip: incomePct != null && incomePct > 100 ? { label: "Above plan", tone: "ok" } : null,
      bar: incomePct != null ? { fraction: s.receivedIncome / s.plannedIncome, tone: "ok" } : null,
    },
  ];
  if (showDebt) {
    tiles.push({
      key: "debt",
      label: "Debt paid",
      value: fmt(s.paidDebt),
      valueTone: "plain",
      caption: debtPct != null ? `${debtPct}% of ${fmt(s.plannedDebt)}` : "paid",
      bar: debtPct != null ? { fraction: s.paidDebt / s.plannedDebt, tone: "info" } : null,
    });
  }

  const pairs: (typeof tiles)[] = [];
  for (let i = 0; i < tiles.length; i += 2) pairs.push(tiles.slice(i, i + 2));
  return (
    <View style={styles.grid}>
      {pairs.map((pair, i) => (
        <View key={i} style={styles.gridRow}>
          {pair.map(({ key, ...tile }) => (
            <Tile key={key} {...tile} />
          ))}
          {pair.length === 1 ? <View style={styles.tileSpacer} /> : null}
        </View>
      ))}
    </View>
  );
}

/** A section's % chip: income green once it reaches plan, debt blue, spending by how much is used. */
function sectionChipTone(section: BudgetSection, pct: number): Tone {
  if (section === "income") return pct >= 100 ? "ok" : "muted";
  if (section === "debt") return "info";
  return pct > 100 ? "over" : pct >= ALMOST_SPENT_AT * 100 ? "warn" : "ok";
}

/**
 * Name and right-hand figure, then the amounts and a bar on one line under them.
 * `settable` draws "+ Set budget" on a line with no budget. It is part of the
 * row, not a button of its own: the whole row already opens the budget sheet,
 * and a button nested in another is hidden from screen readers.
 */
function RowLines({
  name,
  view,
  nameStyle,
  badge,
  leading,
  settable,
}: {
  name: string;
  view: RowView;
  nameStyle?: object;
  badge?: React.ReactNode;
  leading?: React.ReactNode;
  settable?: boolean;
}) {
  const { colors } = useTheme();
  const toneColor = useToneColor();
  const unbudgeted = view.state === "unbudgeted";
  return (
    <>
      <View style={styles.rowLine}>
        {leading}
        <Text
          style={[styles.rowName, { color: unbudgeted ? colors.mutedForeground : colors.foreground }, nameStyle]}
          numberOfLines={1}
        >
          {name}
        </Text>
        {badge}
        {view.state === "almost" ? (
          <View style={styles.almostChip}>
            <Chip label="Almost spent" tone="warn" />
          </View>
        ) : null}
        {unbudgeted && settable ? (
          <View style={[styles.setBudget, { borderColor: colors.primary }]}>
            <Icon name="add" size={13} color={colors.primary} />
            <Text style={[styles.setBudgetText, { color: colors.primary }]}>Set budget</Text>
          </View>
        ) : null}
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
  // The display currency, which the server uses for every amount on this screen.
  // The last loaded month's stands in while the next one loads, so the caption
  // under the month doesn't flicker.
  const currency = (shown ?? data)?.currency ?? "";
  const fmt = (n: number) => formatWholeMoney(n, currency);

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
            <HeroCard data={shown} fmt={fmt} />
            <SummaryGrid data={shown} fmt={fmt} />
            {hasAnyBudget(shown) ? null : (
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>Tap a line to set its budget.</Text>
            )}
          </>
        ) : null;
      case "section": {
        const key = sectionKey(row.section);
        const compact = (n: number) => formatCompactMoney(n, currency);
        const pct = percentOf(row.actual, row.planned);
        return (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${row.title}${row.collapsible ? (row.collapsed ? ", show" : ", hide") : ""}`}
            activeOpacity={0.7}
            onPress={row.collapsible ? () => toggleCollapsed(key) : undefined}
            style={[styles.sectionHeader, { borderBottomColor: colors.border }]}
          >
            {row.collapsible ? (
              <Icon name={row.collapsed ? "chevronRight" : "chevronDown"} size={16} color={colors.mutedForeground} />
            ) : null}
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{row.title}</Text>
            <Text style={[styles.sectionAmounts, { color: colors.mutedForeground }]}>
              {row.planned > 0.005 ? `${compact(row.actual)} of ${compact(row.planned)}` : compact(row.actual)}
            </Text>
            {pct != null ? (
              <View style={styles.sectionChip}>
                <Chip label={`${pct}%`} tone={sectionChipTone(row.section, pct)} />
              </View>
            ) : null}
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
              settable={group.byGroup}
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
              settable={!row.inGroupBudget}
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
    // "Due", not "Due later", so the four chips fit on a 390px screen.
    { key: "upcoming", label: "Due", count: counts?.upcoming },
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
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          onPress={() => goToMonth(monthOffset - 1)}
          style={[styles.navCircle, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Icon name="chevronLeft" size={18} color={colors.primary} />
        </TouchableOpacity>
        <View style={styles.monthCenter}>
          <Text style={[styles.monthLabel, { color: colors.foreground }]}>{formatMonthLabel(month)}</Text>
          {currency ? (
            <Text style={[styles.monthCaption, { color: colors.mutedForeground }]}>All amounts in {currency}</Text>
          ) : null}
          {monthOffset !== 0 ? (
            <TouchableOpacity accessibilityRole="button" hitSlop={6} onPress={() => goToMonth(0)}>
              <Text style={[styles.thisMonth, { color: colors.primary }]}>This month</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Next month"
          onPress={() => goToMonth(monthOffset + 1)}
          style={[styles.navCircle, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Icon name="chevronRight" size={18} color={colors.primary} />
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
    paddingVertical: 8,
  },
  monthCenter: { alignItems: "center", flexShrink: 1, paddingHorizontal: 8 },
  // 44px round targets (FINLYNQ-318), replacing the "← Prev / Next →" text links.
  navCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  monthLabel: { fontSize: 17, fontWeight: "700" },
  monthCaption: { fontSize: 12, marginTop: 2 },
  thisMonth: { fontSize: 12, fontWeight: "600", marginTop: 2 },
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
  // Every amount on this screen uses tabular digits so columns line up.
  hero: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 18, marginBottom: 10 },
  heroLabel: { fontSize: 13, fontWeight: "600" },
  heroValue: { fontSize: 44, fontWeight: "800", letterSpacing: -1, marginTop: 6, fontVariant: ["tabular-nums"] },
  heroNote: { fontSize: 15, marginTop: 6, fontVariant: ["tabular-nums"] },
  heroBarWrap: { marginTop: 14, height: 20, justifyContent: "center" },
  heroBar: { height: 10, borderRadius: 5, overflow: "hidden" },
  heroFill: { height: 10, borderRadius: 5 },
  todayMark: { position: "absolute", top: 0, bottom: 0, width: 3, borderRadius: 2, marginLeft: -1.5 },
  heroPaceRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8, gap: 8 },
  heroCaption: { fontSize: 12, lineHeight: 16, marginTop: 4, fontVariant: ["tabular-nums"] },
  heroDivider: { height: StyleSheet.hairlineWidth, marginTop: 14, marginBottom: 12 },
  heroDueRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heroDueLabel: { fontSize: 14 },
  heroDueValue: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  grid: { gap: 10, marginBottom: 6 },
  gridRow: { flexDirection: "row", gap: 10 },
  tile: { flex: 1, minWidth: 0, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 6 },
  tileSpacer: { flex: 1 },
  tileHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 },
  tileLabel: { flexShrink: 1, fontSize: 12, fontWeight: "600" },
  tileValue: { fontSize: 22, fontWeight: "800", fontVariant: ["tabular-nums"] },
  tileCaption: { fontSize: 12, fontVariant: ["tabular-nums"] },
  miniBar: { height: 4, borderRadius: 2, overflow: "hidden" },
  miniBarFill: { height: 4, borderRadius: 2 },
  chipSm: {
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: "hidden",
    fontVariant: ["tabular-nums"],
  },
  chipMd: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    overflow: "hidden",
    fontVariant: ["tabular-nums"],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    marginTop: 4,
    marginBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionTitle: { flex: 1, fontSize: 17, fontWeight: "700", marginLeft: 8 },
  sectionAmounts: { fontSize: 14, fontVariant: ["tabular-nums"] },
  sectionChip: { marginLeft: 8, minWidth: 40, alignItems: "flex-end" },
  // Rows sit edge to edge in one bordered block; the first and last round its
  // corners.
  row: {
    minHeight: 48,
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  rowLast: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16, marginBottom: 10 },
  lineRow: { paddingLeft: 16 },
  rowLine: { flexDirection: "row", alignItems: "center" },
  rowName: { flexShrink: 1, flexGrow: 1, fontSize: 15, fontWeight: "600", marginRight: 6 },
  groupName: { fontSize: 16, fontWeight: "700" },
  rowRight: { flexShrink: 0, fontSize: 15, fontWeight: "700", marginLeft: "auto", fontVariant: ["tabular-nums"] },
  rowMeta: { flexShrink: 1, fontSize: 13, marginTop: 4, fontVariant: ["tabular-nums"] },
  almostChip: { marginRight: 8 },
  setBudget: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    borderWidth: 1,
    borderStyle: "dashed",
    marginLeft: "auto",
  },
  setBudgetText: { fontSize: 13, fontWeight: "700" },
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
