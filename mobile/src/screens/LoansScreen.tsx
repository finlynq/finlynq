// Loans — what is owed, what each payment is, and when each loan ends.
//
// "Add loan" enters a new one; tapping a loan opens its payment schedule, from
// where it can be edited and its interest booked. Paid-off loans are kept out
// of the way behind a "Show paid-off" row (in-app feedback: a loan at zero
// should hide itself, with a way to see it).
//
// Every per-loan figure is in the LOAN's own currency. The two totals at the
// top use the server's display-currency companions, the only figures that are
// safe to add across loans.
//
// A Cards / List switch in the header shows each loan as a two-line row instead
// of a card (in-app feedback 2026-10-15: with 17 loans, about three cards fit on
// a screen). The choice is remembered on the device.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import { DISPLAY_CURRENCY_FALLBACK } from "../lib/constants";
import { Icon } from "../components/icon";
import {
  LOAN_FREQUENCY_LABEL,
  LOANS_VIEW_KEY,
  PAYMENT_FREQUENCY_SHORT,
  loanPaidPct,
  loanRateLabel,
  loanTotals,
  loanTypeLabel,
  parseLoansView,
  splitLoans,
  type LoansView,
} from "../lib/loans";
import type { LoanSummary } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Row =
  | { kind: "summary" }
  // `first` / `last` round the corners of a block of compact rows.
  | { kind: "loan"; loan: LoanSummary; completed: boolean; first: boolean; last: boolean }
  | { kind: "toggle"; count: number }
  | { kind: "note" }
  | { kind: "error"; message: string };

export default function LoansScreen() {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList, "Loans">>();
  const [loans, setLoans] = useState<LoanSummary[]>([]);
  // Full-screen spinner only until the first response; focus refetches after
  // that update the list in place.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [view, setView] = useState<LoansView>("cards");
  // Set once the user picks a view, so a slow storage read cannot undo the tap.
  const viewChosen = useRef(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(LOANS_VIEW_KEY)
      .then((v) => {
        if (alive && !viewChosen.current) setView(parseLoansView(v));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const changeView = (next: LoansView) => {
    viewChosen.current = true;
    setView(next);
    AsyncStorage.setItem(LOANS_VIEW_KEY, next).catch(() => {});
  };

  const fetchLoans = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await endpoints.getLoans();
      if (res.success) {
        setLoans(Array.isArray(res.data) ? res.data : []);
        setError(null);
      } else {
        logger.warn("loans", "fetch failed", { error: res.error });
        setError(res.error);
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("loans", "fetch threw", { detail });
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isFocused) fetchLoans();
  }, [isFocused, fetchLoans]);

  const { active, completed } = useMemo(() => splitLoans(loans), [loans]);
  const totals = useMemo(() => loanTotals(active), [active]);
  const displayCurrency = loans[0]?.displayCurrency || DISPLAY_CURRENCY_FALLBACK;

  const rows = useMemo<Row[]>(() => {
    if (loans.length === 0) return []; // ListEmptyComponent covers error + empty
    const out: Row[] = [];
    // A failed reload is shown even when loans are already listed (the list
    // keeps the last good data underneath).
    if (error) out.push({ kind: "error", message: error });
    const pushLoans = (list: LoanSummary[], isCompleted: boolean) =>
      list.forEach((l, i) =>
        out.push({ kind: "loan", loan: l, completed: isCompleted, first: i === 0, last: i === list.length - 1 }),
      );
    if (active.length > 0) out.push({ kind: "summary" });
    pushLoans(active, false);
    if (completed.length > 0) {
      out.push({ kind: "toggle", count: completed.length });
      if (showCompleted) pushLoans(completed, true);
    }
    out.push({ kind: "note" });
    return out;
  }, [loans, active, completed, showCompleted, error]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // One loan in two lines: name and balance; payment, rate, share paid, end.
  const renderCompactLoan = (loan: LoanSummary, isCompleted: boolean, first: boolean, last: boolean) => {
    const currency = loan.currency || displayCurrency;
    const broken = loan.remainingBalance == null;
    const pct = loanPaidPct(loan);
    const payment = loan.paymentPerPeriod ?? loan.monthlyPayment;
    const per = PAYMENT_FREQUENCY_SHORT[loan.paymentFrequency] ?? "";
    const left = isCompleted
      ? `Paid off · ${loanRateLabel(loan)}`
      : `${formatCurrency(payment ?? 0, currency)}${per} · ${loanRateLabel(loan)}`;
    const right = `${pct.toFixed(0)}% paid${!isCompleted && loan.payoffDate ? ` · ends ${loan.payoffDate.slice(0, 7)}` : ""}`;
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${safeName(loan.name)}, ${broken ? "fix its details" : "payment schedule"}`}
        activeOpacity={0.7}
        onPress={() => (broken ? navigation.navigate("AddLoan", { loan }) : navigation.navigate("LoanDetail", { loan }))}
        style={[
          styles.compactRow,
          { backgroundColor: colors.card, borderColor: colors.border },
          first && styles.compactFirst,
          last && styles.compactLast,
          isCompleted && styles.cardCompleted,
        ]}
      >
        <View style={styles.compactLine}>
          <Text style={[styles.compactName, { color: colors.foreground }]} numberOfLines={1}>
            {safeName(loan.name)}
          </Text>
          {!broken && (
            <Text style={[styles.compactBalance, { color: isCompleted ? colors.pos : colors.foreground }]}>
              {formatCurrency(loan.remainingBalance ?? 0, currency, { decimals: 0 })}
            </Text>
          )}
        </View>
        {broken ? (
          <Text style={[styles.compactMeta, { color: colors.destructive }]} numberOfLines={1}>
            Could not be scheduled. Tap to fix.
          </Text>
        ) : (
          <View style={styles.compactLine}>
            <Text style={[styles.compactMeta, styles.compactMetaLeft, { color: colors.mutedForeground }]} numberOfLines={1}>
              {left}
            </Text>
            <Text style={[styles.compactMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
              {right}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderLoan = (loan: LoanSummary, isCompleted: boolean) => {
    const currency = loan.currency || displayCurrency;
    // The server could not build a schedule for this loan (a bad date, a
    // payment that never pays it off). It needs fixing, not hiding.
    const broken = loan.remainingBalance == null;
    const pct = loanPaidPct(loan);
    const payment = loan.paymentPerPeriod ?? loan.monthlyPayment;
    const frequency = LOAN_FREQUENCY_LABEL[loan.paymentFrequency] ?? "Payment";
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${safeName(loan.name)}, ${broken ? "fix its details" : "payment schedule"}`}
        activeOpacity={0.7}
        // A loan the server could not schedule has no schedule to open; its
        // form is where it gets fixed (or deleted).
        onPress={() => (broken ? navigation.navigate("AddLoan", { loan }) : navigation.navigate("LoanDetail", { loan }))}
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border },
          isCompleted && styles.cardCompleted,
        ]}
      >
        <View style={styles.cardTop}>
          <View style={[styles.iconWrap, { backgroundColor: colors.secondary }]}>
            <Icon name="loans" size={18} color={colors.primary} />
          </View>
          <View style={styles.cardText}>
            <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
              {safeName(loan.name)}
            </Text>
            <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
              {loanTypeLabel(loan.type)}
              {` · ${loanRateLabel(loan)}`}
              {isCompleted ? " · Paid off" : ""}
            </Text>
          </View>
          {!broken && (
            <Text style={[styles.balance, { color: isCompleted ? colors.pos : colors.foreground }]}>
              {formatCurrency(loan.remainingBalance ?? 0, currency, { decimals: 0 })}
            </Text>
          )}
        </View>

        {broken ? (
          <Text style={[styles.detail, { color: colors.destructive }]}>
            This loan could not be scheduled. Tap to fix its details.
          </Text>
        ) : (
          <>
            <View style={[styles.track, { backgroundColor: colors.secondary }]}>
              <View style={[styles.fill, { backgroundColor: isCompleted ? colors.pos : colors.primary, width: `${pct}%` }]} />
            </View>
            <View style={styles.detailRow}>
              <Text style={[styles.detail, { color: colors.mutedForeground }]}>
                {pct.toFixed(0)}% paid of {formatCurrency(loan.principal, currency, { decimals: 0 })}
                {loan.balanceSource === "account" ? " · from account" : ""}
              </Text>
            </View>
            {!isCompleted && (
              <View style={styles.detailRow}>
                <Text style={[styles.detail, { color: colors.mutedForeground }]}>
                  {frequency}: <Text style={{ color: colors.foreground }}>{formatCurrency(payment ?? 0, currency)}</Text>
                </Text>
                {loan.payoffDate ? (
                  <Text style={[styles.detail, { color: colors.mutedForeground }]}>
                    Ends <Text style={{ color: colors.foreground }}>{loan.payoffDate}</Text>
                  </Text>
                ) : null}
              </View>
            )}
          </>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Loans</Text>
        {loans.length > 0 && (
          <View style={[styles.segment, { backgroundColor: colors.secondary }]} accessibilityLabel="How loans are shown">
            {(["cards", "list"] as LoansView[]).map((v) => (
              <TouchableOpacity
                key={v}
                accessibilityRole="button"
                accessibilityState={{ selected: view === v }}
                onPress={() => changeView(v)}
                style={[styles.segmentBtn, view === v && { backgroundColor: colors.card }]}
              >
                <Text style={[styles.segmentText, { color: view === v ? colors.foreground : colors.mutedForeground }]}>
                  {v === "cards" ? "Cards" : "List"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Add loan"
          style={[styles.addBtn, { borderColor: colors.border }]}
          onPress={() => navigation.navigate("AddLoan")}
        >
          <Icon name="add" size={15} color={colors.primary} />
          <Text style={[styles.addText, { color: colors.primary }]}>Add loan</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => (row.kind === "loan" ? `loan-${row.loan.id}` : row.kind)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchLoans(true)} />}
        renderItem={({ item: row }) => {
          switch (row.kind) {
            case "loan":
              return view === "list"
                ? renderCompactLoan(row.loan, row.completed, row.first, row.last)
                : renderLoan(row.loan, row.completed);
            case "summary":
              return (
                <View style={[styles.summary, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.summaryCell}>
                    <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>TOTAL OWED</Text>
                    <Text style={[styles.summaryValue, { color: colors.foreground }]}>
                      {formatCurrency(totals.owed, displayCurrency, { decimals: 0 })}
                    </Text>
                  </View>
                  <View style={styles.summaryCell}>
                    <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>PER MONTH</Text>
                    <Text style={[styles.summaryValue, { color: colors.foreground }]}>
                      {formatCurrency(totals.monthly, displayCurrency, { decimals: 0 })}
                    </Text>
                  </View>
                </View>
              );
            case "toggle":
              return (
                <TouchableOpacity
                  accessibilityRole="button"
                  activeOpacity={0.7}
                  onPress={() => setShowCompleted((v) => !v)}
                  style={[styles.toggle, { borderColor: colors.border }]}
                >
                  <Text style={[styles.toggleText, { color: colors.primary }]}>
                    {showCompleted
                      ? "Hide paid-off loans"
                      : `Show ${row.count} paid-off ${row.count === 1 ? "loan" : "loans"}`}
                  </Text>
                </TouchableOpacity>
              );
            case "note":
              return (
                <Text style={[styles.note, { color: colors.mutedForeground }]}>
                  Tap a loan for its payment schedule, to change it, or to book its interest.
                </Text>
              );
            default:
              return <Text style={[styles.errorBanner, { color: colors.destructive }]}>{row.message}</Text>;
          }
        }}
        ListEmptyComponent={
          error ? (
            <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
          ) : (
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              No loans yet. Tap Add loan to enter a mortgage, a car loan or any other debt.
            </Text>
          )
        }
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
    paddingTop: 16,
    paddingBottom: 8,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  addText: { fontSize: 14, fontWeight: "700" },
  header: { fontSize: 28, fontWeight: "800", flex: 1 },
  segment: { flexDirection: "row", borderRadius: 8, padding: 2, marginRight: 8 },
  segmentBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  segmentText: { fontSize: 13, fontWeight: "700" },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  summary: {
    flexDirection: "row",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 10,
  },
  summaryCell: { flex: 1 },
  summaryLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  summaryValue: { fontSize: 20, fontWeight: "800", marginTop: 4, fontVariant: ["tabular-nums"] },
  errorBanner: { fontSize: 14, marginBottom: 10 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 10,
  },
  cardCompleted: { opacity: 0.75 },
  // Compact rows sit edge to edge in one bordered block; the first and last
  // round its corners.
  compactRow: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  compactFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  compactLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12, marginBottom: 10 },
  compactLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  compactName: { flex: 1, fontSize: 15, fontWeight: "600", marginRight: 8 },
  compactBalance: { fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  compactMeta: { fontSize: 12, marginTop: 2, fontVariant: ["tabular-nums"] },
  compactMetaLeft: { flexShrink: 1, marginRight: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  cardText: { flex: 1, marginRight: 8 },
  name: { fontSize: 15, fontWeight: "600" },
  meta: { fontSize: 12, marginTop: 2 },
  balance: { fontSize: 17, fontWeight: "800", fontVariant: ["tabular-nums"] },
  track: { height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 8 },
  fill: { height: 8, borderRadius: 4 },
  detailRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
  detail: { fontSize: 12, fontVariant: ["tabular-nums"] },
  toggle: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
    marginBottom: 10,
  },
  toggleText: { fontSize: 14, fontWeight: "700" },
  note: { fontSize: 12, textAlign: "center", marginTop: 12, lineHeight: 18 },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14, lineHeight: 20 },
});
