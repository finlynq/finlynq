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
// Each loan is one two-line row, the rows grouped in one block (in-app feedback
// 2026-10-15: with 17 loans, the cards these replaced fitted about three to a
// screen). Same change as the web Loans page.

import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import { DISPLAY_CURRENCY_FALLBACK } from "../lib/constants";
import { Icon } from "../components/icon";
import { PAYMENT_FREQUENCY_SHORT, loanPaidPct, loanRateLabel, loanTotals, splitLoans } from "../lib/loans";
import type { LoanSummary } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Row =
  | { kind: "summary" }
  // `first` / `last` round the corners of a block of rows.
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
  const renderLoan = (loan: LoanSummary, isCompleted: boolean, first: boolean, last: boolean) => {
    const currency = loan.currency || displayCurrency;
    // The server could not build a schedule for this loan (a bad date, a
    // payment that never pays it off). It needs fixing, not hiding.
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
        // A loan the server could not schedule has no schedule to open; its
        // form is where it gets fixed (or deleted).
        onPress={() => (broken ? navigation.navigate("AddLoan", { loan }) : navigation.navigate("LoanDetail", { loan }))}
        style={[
          styles.row,
          { backgroundColor: colors.card, borderColor: colors.border },
          first && styles.rowFirst,
          last && styles.rowLast,
          isCompleted && styles.rowCompleted,
        ]}
      >
        <View style={styles.rowLine}>
          <Text style={[styles.rowName, { color: colors.foreground }]} numberOfLines={1}>
            {safeName(loan.name)}
          </Text>
          {!broken && (
            <Text style={[styles.rowBalance, { color: isCompleted ? colors.pos : colors.foreground }]}>
              {formatCurrency(loan.remainingBalance ?? 0, currency, { decimals: 0 })}
            </Text>
          )}
        </View>
        {broken ? (
          <Text style={[styles.rowMeta, { color: colors.destructive }]} numberOfLines={1}>
            Could not be scheduled. Tap to fix.
          </Text>
        ) : (
          <View style={styles.rowLine}>
            <Text style={[styles.rowMeta, styles.rowMetaLeft, { color: colors.mutedForeground }]} numberOfLines={1}>
              {left}
            </Text>
            <Text style={[styles.rowMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
              {right}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Loans</Text>
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
              return renderLoan(row.loan, row.completed, row.first, row.last);
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
  header: { fontSize: 28, fontWeight: "800" },
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
  // Rows sit edge to edge in one bordered block; the first and last round its
  // corners.
  row: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 12, borderTopRightRadius: 12 },
  rowLast: { borderBottomLeftRadius: 12, borderBottomRightRadius: 12, marginBottom: 10 },
  rowCompleted: { opacity: 0.75 },
  rowLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowName: { flex: 1, fontSize: 15, fontWeight: "600", marginRight: 8 },
  rowBalance: { fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  rowMeta: { fontSize: 12, marginTop: 2, fontVariant: ["tabular-nums"] },
  rowMetaLeft: { flexShrink: 1, marginRight: 8 },
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
