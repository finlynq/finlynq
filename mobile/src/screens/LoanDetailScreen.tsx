// One loan: what is owed, its terms, and its payment schedule.
//
// The schedule is the one every surface shows: the server builds it from the
// stored loan and applies the loan's own manual schedule, edited interest and
// interest method (GET /api/loans/schedule). It can be changed here the same
// two ways as on the web: tap a payment to set the interest the lender really
// charged, or make the whole schedule your own and change each row. Uploading a
// spreadsheet stays on the web app.
//
// Every amount is in the LOAN's own currency.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
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
  loanTypeLabel,
  splitSchedule,
} from "../lib/loans";
import type {
  LoanScheduleChange,
  LoanScheduleRow,
  LoanScheduleState,
  LoanSummary,
} from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Props = NativeStackScreenProps<MoreStackParamList, "LoanDetail">;

// The loan's figures and the closing note are rows of the list too, so the
// whole screen scrolls as one.
type Row =
  | { kind: "header" }
  | { kind: "toggle"; count: number }
  | { kind: "payment"; row: LoanScheduleRow; past: boolean; next: boolean }
  | { kind: "note" };

const NETWORK_ERROR = "Cannot connect to server";
const amount = (s: string) => parseFloat(s.trim().replace(",", "."));

export default function LoanDetailScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  // The route param is only the seed: the loan is re-read every time the
  // screen regains focus, so an edit made on the form shows here.
  const [loan, setLoan] = useState<LoanSummary>(route.params.loan);
  const loanId = route.params.loan.id;
  const currency = loan.currency || loan.displayCurrency || DISPLAY_CURRENCY_FALLBACK;
  const [state, setState] = useState<LoanScheduleState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  // One schedule change at a time.
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The payment being edited, with the form's text.
  const [editRow, setEditRow] = useState<LoanScheduleRow | null>(null);
  const [editInterest, setEditInterest] = useState("");
  const [editPayment, setEditPayment] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  // Drops a response that a newer request (or leaving the screen) superseded.
  const seq = useRef(0);

  const load = useCallback(
    async (isRefresh = false) => {
      const mine = ++seq.current;
      if (isRefresh) setRefreshing(true);
      try {
        const [sched, list] = await Promise.all([
          endpoints.getLoanSchedule(loanId),
          // The loan's own figures; a failure here keeps what is on screen.
          endpoints.getLoans().catch(() => null),
        ]);
        if (mine !== seq.current) return;
        if (list && list.success && Array.isArray(list.data)) {
          const fresh = list.data.find((l) => l.id === loanId);
          if (fresh) setLoan(fresh);
        }
        if (sched.success && Array.isArray(sched.data?.summary?.schedule)) {
          setState(sched.data);
          setError(null);
        } else {
          const message = sched.success ? "The schedule could not be read." : sched.error;
          logger.warn("loan-detail", "schedule failed", { error: message });
          setError(message);
        }
      } catch (e) {
        logger.error("loan-detail", "schedule threw", { detail: String(e) });
        if (mine === seq.current) setError(NETWORK_ERROR);
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [loanId],
  );

  useEffect(() => {
    if (isFocused) load();
    return () => {
      seq.current++;
    };
  }, [isFocused, load]);

  const schedule = state?.summary.schedule ?? [];
  const manual = (state?.mode ?? loan.scheduleMode) === "manual";
  const editedCount = state ? Object.keys(state.interestOverrides ?? {}).length : 0;

  const { past, upcoming } = useMemo(() => splitSchedule(schedule, localDateISO()), [schedule]);

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

  /** Apply one change to the schedule. True when the server accepted it. */
  const applyChange = useCallback(
    async (change: Omit<LoanScheduleChange, "loanId">, onError: (message: string) => void): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      try {
        const res = await endpoints.saveLoanSchedule({ loanId, ...change });
        if (res.success && Array.isArray(res.data?.summary?.schedule)) {
          setState(res.data);
          return true;
        }
        const message = res.success ? "The schedule could not be read." : res.error;
        logger.warn("loan-detail", "schedule change rejected", { error: message });
        onError(message || "Please try again.");
        return false;
      } catch (e) {
        logger.error("loan-detail", "schedule change threw", { detail: String(e) });
        onError(NETWORK_ERROR);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, loanId],
  );

  const openEdit = (r: LoanScheduleRow) => {
    setEditRow(r);
    setEditInterest(String(r.interest));
    setEditPayment(String(r.payment));
    setEditError(null);
  };
  const closeEdit = () => {
    if (busy) return;
    setEditRow(null);
  };

  const saveEdit = async () => {
    if (!editRow) return;
    const interest = amount(editInterest);
    if (!Number.isFinite(interest) || interest < 0) {
      setEditError("Enter the interest, 0 or more.");
      return;
    }
    let change: Omit<LoanScheduleChange, "loanId">;
    if (manual) {
      const payment = amount(editPayment);
      if (!Number.isFinite(payment) || payment <= 0) {
        setEditError("Enter the payment, greater than 0.");
        return;
      }
      if (interest > payment) {
        setEditError("The interest cannot be more than the payment.");
        return;
      }
      // Lay this one row over the schedule; the others stay as they are.
      change = { manualSchedule: [{ date: editRow.date, payment, interest }], mergeRows: true };
    } else {
      change = { interestOverrides: { [editRow.date]: interest } };
    }
    setEditError(null);
    if (await applyChange(change, setEditError)) setEditRow(null);
  };

  const resetEdit = async () => {
    if (!editRow) return;
    setEditError(null);
    if (await applyChange({ interestOverrides: { [editRow.date]: null } }, setEditError)) setEditRow(null);
  };

  const resetAllEdits = () => {
    setActionError(null);
    void applyChange({ clearInterestOverrides: true }, setActionError);
  };

  const makeOwn = () => {
    Alert.alert(
      "Make this schedule your own?",
      "Every payment becomes a row you can change. The schedule then stops recalculating when you change the loan's rate or term.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Make it mine",
          onPress: () => {
            setActionError(null);
            void applyChange(
              { manualSchedule: schedule.map((r) => ({ date: r.date, payment: r.payment, interest: r.interest })) },
              setActionError,
            );
          },
        },
      ],
    );
  };

  const backToCalculated = () => {
    Alert.alert(
      "Go back to the calculated schedule?",
      "Your own rows are discarded and the schedule is worked out from the loan's terms again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Go back",
          style: "destructive",
          onPress: () => {
            setActionError(null);
            void applyChange({ manualSchedule: null }, setActionError);
          },
        },
      ],
    );
  };

  const completed = isLoanCompleted(loan);
  const pct = loanPaidPct(loan);
  const payment = loan.paymentPerPeriod ?? loan.monthlyPayment;
  // "every 2 weeks", "monthly"; nothing for a frequency this app has no name for.
  const frequency = LOAN_FREQUENCY_LABEL[loan.paymentFrequency]?.toLowerCase();
  const totalInterest = state?.summary.totalInterest ?? loan.totalInterest;
  const payoffDate = state?.summary.payoffDate ?? loan.payoffDate;

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
          {payoffDate ? <KV k="Ends" v={payoffDate} /> : null}
          {loan.accountName ? <KV k="Linked account" v={safeName(loan.accountName)} /> : null}
        </View>
      </View>

      {loan.balanceSource === "account" ? (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>
          The balance above comes from the linked account. The schedule below shows the loan as planned.
        </Text>
      ) : null}

      <TouchableOpacity
        accessibilityRole="button"
        activeOpacity={0.7}
        onPress={() => navigation.navigate("LoanInterest", { loan })}
        style={[styles.linkRow, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.linkText}>
          <Text style={[styles.linkTitle, { color: colors.foreground }]}>Interest entries</Text>
          <Text style={[styles.linkSub, { color: colors.mutedForeground }]}>
            Book each payment&apos;s interest on the loan&apos;s account
          </Text>
        </View>
        <Icon name="chevronRight" size={16} color={colors.mutedForeground} />
      </TouchableOpacity>

      <Text style={[styles.section, { color: colors.mutedForeground }]}>
        {manual ? "Payment schedule · your own" : "Payment schedule"}
      </Text>
      {loading ? <ActivityIndicator style={{ paddingVertical: 24 }} color={colors.primary} /> : null}
      {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}

      {!loading && !error && state ? (
        <>
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            {manual
              ? "These are your own rows. Tap a payment to change its amount or its interest."
              : "Worked out from the loan's terms. Tap a payment to set the interest your lender really charged."}
          </Text>
          <View style={styles.actions}>
            {!manual && editedCount > 0 ? (
              <ActionChip
                label={`Reset ${editedCount} edited ${editedCount === 1 ? "payment" : "payments"}`}
                onPress={resetAllEdits}
                disabled={busy}
              />
            ) : null}
            {manual ? (
              <ActionChip label="Back to the calculated schedule" onPress={backToCalculated} disabled={busy} />
            ) : schedule.length > 0 ? (
              <ActionChip label="Make this schedule my own" onPress={makeOwn} disabled={busy} />
            ) : null}
          </View>
          {actionError ? <Text style={[styles.error, { color: colors.destructive }]}>{actionError}</Text> : null}
        </>
      ) : null}

      {!loading && !error && state && schedule.length === 0 ? (
        <Text style={[styles.empty, { color: colors.mutedForeground }]}>This loan has no payments scheduled.</Text>
      ) : null}
      {!loading && !error && state && schedule.length > 0 && upcoming.length === 0 ? (
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
        <TouchableOpacity
          style={styles.edit}
          onPress={() => navigation.navigate("AddLoan", { loan })}
          accessibilityRole="button"
          accessibilityLabel="Edit loan"
        >
          <Text style={[styles.backText, { color: colors.primary }]}>Edit</Text>
        </TouchableOpacity>
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
                To upload a whole schedule from a spreadsheet, use the web app.
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
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Payment on ${r.date}`}
              activeOpacity={0.7}
              onPress={() => openEdit(r)}
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
            </TouchableOpacity>
          );
        }}
      />

      <Modal visible={editRow != null} animationType="slide" transparent onRequestClose={closeEdit}>
        <Pressable style={styles.backdrop} onPress={closeEdit}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: colors.card, borderColor: colors.border, paddingTop: insets.top + 12 },
            ]}
            onPress={() => {}}
          >
            {editRow ? (
              <>
                <View style={styles.sheetHeader}>
                  <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Payment on {editRow.date}</Text>
                  <TouchableOpacity onPress={closeEdit} hitSlop={8} accessibilityLabel="Close">
                    <Icon name="close" size={20} color={colors.mutedForeground} />
                  </TouchableOpacity>
                </View>

                {manual ? (
                  <>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>PAYMENT</Text>
                    <TextInput
                      accessibilityLabel="Payment"
                      style={[styles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                      value={editPayment}
                      onChangeText={setEditPayment}
                      keyboardType="decimal-pad"
                    />
                  </>
                ) : null}

                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>INTEREST</Text>
                <TextInput
                  accessibilityLabel="Interest"
                  style={[styles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                  value={editInterest}
                  onChangeText={setEditInterest}
                  keyboardType="decimal-pad"
                  autoFocus
                />
                <Text style={[styles.note, { color: colors.mutedForeground, marginTop: 8 }]}>
                  {manual
                    ? "What is left of the payment after interest comes off the balance."
                    : `The payment stays ${formatCurrency(editRow.payment, currency)}, so the rest comes off the balance and later payments follow.`}
                </Text>
                {editError ? <Text style={[styles.error, { color: colors.destructive }]}>{editError}</Text> : null}

                <View style={styles.sheetButtons}>
                  {!manual && editRow.interestOverridden ? (
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={busy ? undefined : resetEdit}
                      style={[styles.secondaryBtn, { borderColor: colors.border }]}
                    >
                      <Text style={[styles.secondaryText, { color: colors.foreground }]}>Use the calculated interest</Text>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Save payment"
                    onPress={busy ? undefined : saveEdit}
                    style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
                  >
                    {busy ? (
                      <ActivityIndicator size="small" color={colors.primaryForeground} />
                    ) : (
                      <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>Save</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function ActionChip({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      activeOpacity={0.7}
      onPress={disabled ? undefined : onPress}
      style={[styles.chip, { borderColor: colors.border, opacity: disabled ? 0.6 : 1 }]}
    >
      <Text style={[styles.chipText, { color: colors.primary }]}>{label}</Text>
    </TouchableOpacity>
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
  edit: { width: 70, alignItems: "flex-end" },
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
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 16,
  },
  linkText: { flex: 1, marginRight: 8 },
  linkTitle: { fontSize: 15, fontWeight: "600" },
  linkSub: { fontSize: 12, marginTop: 2 },
  section: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 8, marginTop: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", marginBottom: 4 },
  chip: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
    marginBottom: 8,
  },
  chipText: { fontSize: 13, fontWeight: "700" },
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
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-start" },
  sheet: {
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  sheetTitle: { fontSize: 17, fontWeight: "700" },
  fieldLabel: { fontSize: 12, fontWeight: "600", marginBottom: 6, marginTop: 4 },
  input: { fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 4 },
  sheetButtons: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", marginTop: 4 },
  secondaryBtn: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 8,
    marginBottom: 8,
  },
  secondaryText: { fontSize: 14, fontWeight: "600" },
  primaryBtn: { borderRadius: 8, paddingHorizontal: 22, paddingVertical: 10, marginBottom: 8, minWidth: 84, alignItems: "center" },
  primaryText: { fontSize: 15, fontWeight: "700" },
});
