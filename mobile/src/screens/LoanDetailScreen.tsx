// One loan: what is owed, its terms, and its payment schedule.
//
// The schedule is the same one the web's schedule panel shows: the server
// builds it from the loan's terms and applies the loan's own manual schedule,
// edited interest and interest method (POST /api/loans, action "amortization").
// Read-only here; changing a schedule or booking interest stays on the web app.
//
// Every amount is in the LOAN's own currency.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName } from "../lib/format";
import { DISPLAY_CURRENCY_FALLBACK } from "../lib/constants";
import { localDateISO } from "../lib/subscriptions";
import { Icon } from "../components/icon";
import {
  LOAN_FREQUENCY_LABEL,
  isLoanCompleted,
  loanPaidPct,
  loanRateLabel,
  loanScheduleRequest,
  loanTypeLabel,
  splitSchedule,
} from "../lib/loans";
import type { LoanSchedule, LoanScheduleRow } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Props = NativeStackScreenProps<MoreStackParamList, "LoanDetail">;

// The loan's figures and the closing note are rows of the list too, so the
// whole screen scrolls as one.
type Row =
  | { kind: "header" }
  | { kind: "toggle"; count: number }
  | { kind: "payment"; row: LoanScheduleRow; past: boolean; next: boolean }
  | { kind: "note" };

export default function LoanDetailScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const { loan } = route.params;
  const currency = loan.currency || loan.displayCurrency || DISPLAY_CURRENCY_FALLBACK;
  const [schedule, setSchedule] = useState<LoanSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  // Drops a response that a newer request (or leaving the screen) superseded.
  const seq = useRef(0);

  const load = useCallback(
    async (isRefresh = false) => {
      const mine = ++seq.current;
      if (isRefresh) setRefreshing(true);
      try {
        const res = await endpoints.getLoanSchedule(loanScheduleRequest(loan));
        if (mine !== seq.current) return;
        if (res.success && Array.isArray(res.data?.schedule)) {
          setSchedule(res.data);
          setError(null);
        } else {
          const message = res.success ? "The schedule could not be read." : res.error;
          logger.warn("loan-detail", "schedule failed", { error: message });
          setError(message);
        }
      } catch (e) {
        logger.error("loan-detail", "schedule threw", { detail: String(e) });
        if (mine === seq.current) setError("Cannot connect to server");
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [loan],
  );

  useEffect(() => {
    load();
    return () => {
      seq.current++;
    };
  }, [load]);

  const { past, upcoming } = useMemo(
    () => splitSchedule(schedule?.schedule ?? [], localDateISO()),
    [schedule],
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [{ kind: "header" }];
    if (past.length > 0) {
      out.push({ kind: "toggle", count: past.length });
      if (showPast) for (const r of past) out.push({ kind: "payment", row: r, past: true, next: false });
    }
    upcoming.forEach((r, i) => out.push({ kind: "payment", row: r, past: false, next: i === 0 }));
    out.push({ kind: "note" });
    return out;
  }, [past, upcoming, showPast]);

  const completed = isLoanCompleted(loan);
  const pct = loanPaidPct(loan);
  const payment = loan.paymentPerPeriod ?? loan.monthlyPayment;
  // "every 2 weeks", "monthly"; nothing for a frequency this app has no name for.
  const frequency = LOAN_FREQUENCY_LABEL[loan.paymentFrequency]?.toLowerCase();
  const totalInterest = schedule?.totalInterest ?? loan.totalInterest;
  const manual = (schedule?.scheduleMode ?? loan.scheduleMode) === "manual";

  const header = (
    <View>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>
          {completed ? "Paid off" : "Remaining"}
        </Text>
        <Text style={[styles.cardValue, { color: completed ? colors.pos : colors.foreground }]}>
          {formatCurrency(loan.remainingBalance ?? 0, currency)}
        </Text>
        <View style={[styles.track, { backgroundColor: colors.secondary }]}>
          <View
            style={[styles.fill, { backgroundColor: completed ? colors.pos : colors.primary, width: `${pct}%` }]}
          />
        </View>
        <Text style={[styles.cardSub, { color: colors.mutedForeground }]}>
          {pct.toFixed(0)}% paid of {formatCurrency(loan.principal, currency, { decimals: 0 })}
        </Text>
        <View style={styles.kvBlock}>
          <KV
            k="Payment"
            v={`${formatCurrency(payment ?? 0, currency)}${frequency ? ` · ${frequency}` : ""}`}
          />
          <KV k="Rate" v={loanRateLabel(loan)} />
          {totalInterest != null ? <KV k="Total interest" v={formatCurrency(totalInterest, currency)} /> : null}
          {loan.payoffDate ? <KV k="Ends" v={loan.payoffDate} /> : null}
          {loan.accountName ? <KV k="Linked account" v={safeName(loan.accountName)} /> : null}
        </View>
      </View>

      {loan.balanceSource === "account" ? (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>
          The balance above comes from the linked account. The schedule below shows the loan as planned.
        </Text>
      ) : null}

      <Text style={[styles.section, { color: colors.mutedForeground }]}>
        {manual ? "Payment schedule · your own" : "Payment schedule"}
      </Text>
      {loading ? <ActivityIndicator style={{ paddingVertical: 24 }} color={colors.primary} /> : null}
      {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}
      {!loading && !error && schedule && schedule.schedule.length === 0 ? (
        <Text style={[styles.empty, { color: colors.mutedForeground }]}>This loan has no payments scheduled.</Text>
      ) : null}
      {!loading && !error && schedule && schedule.schedule.length > 0 && upcoming.length === 0 ? (
        <Text style={[styles.empty, { color: colors.mutedForeground }]}>Every scheduled payment is in the past.</Text>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={styles.back}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back to loans"
        >
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Loans</Text>
        </TouchableOpacity>
        <View style={styles.titleWrap}>
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            {safeName(loan.name)}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
            {loanTypeLabel(loan.type)} · {currency}
          </Text>
        </View>
        <View style={{ width: 70 }} />
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === "payment" ? `p-${r.row.period}-${r.row.date}` : r.kind)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
        renderItem={({ item }) => {
          if (item.kind === "header") return header;
          if (item.kind === "note") {
            return (
              <Text style={[styles.note, { color: colors.mutedForeground, textAlign: "center", marginTop: 12 }]}>
                Change the schedule or book a payment&apos;s interest on the web app.
              </Text>
            );
          }
          if (item.kind === "toggle") {
            return (
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.7}
                onPress={() => setShowPast((v) => !v)}
                style={[styles.toggle, { borderColor: colors.border }]}
              >
                <Text style={[styles.toggleText, { color: colors.primary }]}>
                  {showPast
                    ? "Hide earlier payments"
                    : `Show ${item.count} earlier ${item.count === 1 ? "payment" : "payments"}`}
                </Text>
              </TouchableOpacity>
            );
          }
          const r = item.row;
          return (
            <View
              style={[
                styles.payRow,
                { backgroundColor: colors.card, borderColor: item.next ? colors.primary : colors.border },
                item.past && styles.payRowPast,
              ]}
            >
              <View style={styles.payTop}>
                <Text style={[styles.payDate, { color: colors.foreground }]}>
                  {r.date}
                  <Text style={[styles.payMeta, { color: item.next ? colors.primary : colors.mutedForeground }]}>
                    {`  #${r.period}${item.next ? " · next" : ""}`}
                  </Text>
                </Text>
                <Text style={[styles.payAmount, { color: colors.foreground }]}>
                  {formatCurrency(r.payment, currency)}
                </Text>
              </View>
              <Text style={[styles.payBreakdown, { color: colors.mutedForeground }]}>
                Interest {formatCurrency(r.interest, currency)}
                {r.interestOverridden ? " (edited)" : ""} · Principal {formatCurrency(r.principal, currency)}
              </Text>
              <Text style={[styles.payBreakdown, { color: colors.mutedForeground }]}>
                Balance after {formatCurrency(r.balance, currency)}
              </Text>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.kvRow}>
      <Text style={[styles.kvKey, { color: colors.mutedForeground }]} numberOfLines={1}>
        {k}
      </Text>
      <Text style={[styles.kvVal, { color: colors.foreground }]} numberOfLines={1}>
        {v}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { flexDirection: "row", alignItems: "center", gap: 2, width: 70 },
  backText: { fontSize: 15, fontWeight: "600" },
  titleWrap: { flex: 1, alignItems: "center" },
  title: { fontSize: 17, fontWeight: "700" },
  subtitle: { fontSize: 12, marginTop: 1 },
  list: { padding: 16, paddingBottom: 32 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  cardLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  cardValue: { fontSize: 30, fontWeight: "800", fontVariant: ["tabular-nums"] },
  cardSub: { fontSize: 12, fontVariant: ["tabular-nums"] },
  track: { height: 8, borderRadius: 4, overflow: "hidden", marginTop: 12, marginBottom: 8 },
  fill: { height: 8, borderRadius: 4 },
  kvBlock: { marginTop: 12 },
  kvRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  kvKey: { fontSize: 13, flex: 1, marginRight: 12 },
  kvVal: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  note: { fontSize: 12, lineHeight: 18, marginBottom: 12 },
  section: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 8, marginTop: 4 },
  error: { fontSize: 14, marginBottom: 12 },
  empty: { fontSize: 13, textAlign: "center", paddingVertical: 16 },
  toggle: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: 10,
  },
  toggleText: { fontSize: 14, fontWeight: "700" },
  payRow: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, marginBottom: 8 },
  payRowPast: { opacity: 0.7 },
  payTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 },
  payDate: { fontSize: 14, fontWeight: "600", flex: 1, marginRight: 8 },
  payMeta: { fontSize: 12, fontWeight: "600" },
  payAmount: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  payBreakdown: { fontSize: 12, fontVariant: ["tabular-nums"], marginTop: 1 },
});
