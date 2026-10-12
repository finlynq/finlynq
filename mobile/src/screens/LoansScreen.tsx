// Loans — what is owed, what each payment is, and when each loan ends.
//
// Read-only: loans, their schedules and interest entries are set up on the web
// app. Paid-off loans are kept out of the way behind a "Show paid-off" row
// (in-app feedback: a loan at zero should hide itself, with a way to see it).
//
// Every per-loan figure is in the LOAN's own currency. The two totals at the
// top use the server's display-currency companions, the only figures that are
// safe to add across loans.

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
import { useIsFocused } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import { DISPLAY_CURRENCY_FALLBACK } from "../lib/constants";
import { Icon } from "../components/icon";
import {
  LOAN_FREQUENCY_LABEL,
  loanPaidPct,
  loanRateLabel,
  loanTotals,
  loanTypeLabel,
  splitLoans,
} from "../lib/loans";
import type { LoanSummary } from "../../../shared/types";

type Row =
  | { kind: "summary" }
  | { kind: "loan"; loan: LoanSummary; completed: boolean }
  | { kind: "toggle"; count: number }
  | { kind: "note" }
  | { kind: "error"; message: string };

export default function LoansScreen() {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
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
    if (active.length > 0) out.push({ kind: "summary" });
    for (const l of active) out.push({ kind: "loan", loan: l, completed: false });
    if (completed.length > 0) {
      out.push({ kind: "toggle", count: completed.length });
      if (showCompleted) for (const l of completed) out.push({ kind: "loan", loan: l, completed: true });
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

  const renderLoan = (loan: LoanSummary, isCompleted: boolean) => {
    const currency = loan.currency || displayCurrency;
    // The server could not build a schedule for this loan (a bad date, a
    // payment that never pays it off). It needs fixing, not hiding.
    const broken = loan.remainingBalance == null;
    const pct = loanPaidPct(loan);
    const payment = loan.paymentPerPeriod ?? loan.monthlyPayment;
    const frequency = LOAN_FREQUENCY_LABEL[loan.paymentFrequency] ?? "Payment";
    return (
      <View
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
            This loan could not be scheduled. Open it on the web app to fix its details.
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
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Loans</Text>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => (row.kind === "loan" ? `loan-${row.loan.id}` : row.kind)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchLoans(true)} />}
        renderItem={({ item: row }) => {
          switch (row.kind) {
            case "loan":
              return renderLoan(row.loan, row.completed);
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
                  Add or change loans, their schedules and interest on the web app.
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
              No loans yet. Add one on the web app and it will show here.
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
  headerRow: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
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
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 10,
  },
  cardCompleted: { opacity: 0.75 },
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
