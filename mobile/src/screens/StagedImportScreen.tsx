// One statement file waiting for review (an emailed attachment, an upload or a
// bank feed). The mobile take on the web's /import/pending: say which account
// it belongs to when the file didn't, look over its rows, then send them to the
// account's ledger (rows already there are skipped) or discard the file.
// Categorising happens next, in Reconcile, exactly as after a web approve.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeAccountName, safeName } from "../lib/format";
import { Icon } from "../components/icon";
import { PickerSheet, type PickerOption } from "../components/picker-sheet";
import { describeApproveResult } from "../lib/email-imports";
import type { InboxAccount, StagedImportDetail, StagedImportRow } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Row = { kind: "summary" } | { kind: "row"; row: StagedImportRow } | { kind: "error"; message: string };

export default function StagedImportScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList, "StagedImport">>();
  const { id, title } = useRoute<RouteProp<MoreStackParamList, "StagedImport">>().params;
  const [detail, setDetail] = useState<StagedImportDetail | null>(null);
  const [accounts, setAccounts] = useState<InboxAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickAccount, setPickAccount] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([endpoints.getStagedImport(id), endpoints.getInboxAccounts()]);
      if (d.success) setDetail(d.data);
      else setError(d.error);
      if (a.success) setAccounts(Array.isArray(a.data) ? a.data : []);
    } catch (e) {
      logger.error("staged-import", "load threw", { detail: String(e) });
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const boundId = detail?.staged.boundAccountId ?? null;
  const bound = accounts.find((a) => a.id === boundId) ?? null;
  const rows = useMemo(() => detail?.rows ?? [], [detail]);
  const duplicates = rows.filter((r) => r.isDuplicate).length;
  const toSend = rows.length - duplicates;
  const accountOptions: PickerOption[] = useMemo(
    () => accounts.filter((a) => !a.archived).map((a) => ({ id: a.id, label: safeAccountName(a), sublabel: a.currency })),
    [accounts],
  );

  const bind = async (accountId: number) => {
    setBusy(true);
    setError(null);
    const res = await endpoints.bindStagedImport(id, accountId);
    if (!res.success) setError(res.error);
    await load();
    setBusy(false);
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await endpoints.approveStagedImport(id);
      if (!res.success) {
        setError(res.error);
        return;
      }
      const message = describeApproveResult(res.data);
      const accountId = boundId;
      Alert.alert("Sent", `${message} Categorise them in Reconcile.`, [
        { text: "Done", onPress: () => navigation.goBack() },
        ...(accountId != null
          ? [{ text: "Open Reconcile", onPress: () => navigation.replace("Inbox", { accountId }) }]
          : []),
      ]);
    } catch (e) {
      logger.error("staged-import", "approve threw", { detail: String(e) });
      setError("Cannot connect to server");
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    Alert.alert("Discard this file?", "Its rows are removed and nothing is recorded.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: async () => {
          const res = await endpoints.rejectStagedImport(id);
          if (res.success) navigation.goBack();
          else setError(res.error);
        },
      },
    ]);
  };

  const data: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (error) out.push({ kind: "error", message: error });
    if (detail) {
      out.push({ kind: "summary" });
      for (const row of rows) out.push({ kind: "row", row });
    }
    return out;
  }, [detail, rows, error]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const summary = (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.mutedForeground }]}>ACCOUNT</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={bound ? `Account: ${safeAccountName(bound)}, change it` : "Choose the account"}
        onPress={() => setPickAccount(true)}
        disabled={busy}
        style={[styles.select, { backgroundColor: colors.secondary, borderColor: colors.border }]}
      >
        <Text style={{ color: bound ? colors.foreground : colors.mutedForeground, fontSize: 15 }}>
          {bound ? safeAccountName(bound) : "Which account is this file for?"}
        </Text>
      </TouchableOpacity>
      <Text style={[styles.counts, { color: colors.mutedForeground }]}>
        {rows.length} {rows.length === 1 ? "row" : "rows"}
        {duplicates > 0 ? ` · ${duplicates} already recorded, will be skipped` : ""}
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={busy || boundId == null || toSend === 0 ? undefined : send}
        disabled={busy || boundId == null || toSend === 0}
        style={[styles.primary, { backgroundColor: boundId == null || toSend === 0 ? colors.secondary : colors.primary }]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.primaryForeground} />
        ) : (
          <Text style={{ color: boundId == null || toSend === 0 ? colors.mutedForeground : colors.primaryForeground, fontWeight: "700" }}>
            {boundId == null
              ? "Choose the account first"
              : toSend === 0
                ? "Nothing new to send"
                : `Send ${toSend} to ${safeAccountName(bound ?? { id: boundId })}`}
          </Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" onPress={discard} style={styles.discard}>
        <Text style={{ color: colors.destructive, fontWeight: "600" }}>Discard this file</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} accessibilityLabel="Back">
          <Icon name="back" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.header, { color: colors.foreground }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <FlatList
        data={data}
        keyExtractor={(r) => (r.kind === "row" ? r.row.id : r.kind)}
        contentContainerStyle={styles.list}
        renderItem={({ item: r }) => {
          if (r.kind === "error") return <Text style={[styles.error, { color: colors.destructive }]}>{r.message}</Text>;
          if (r.kind === "summary") return summary;
          const row = r.row;
          return (
            <View style={[styles.row, { borderBottomColor: colors.border }]}>
              <View style={styles.line}>
                <Text style={[styles.payee, { color: colors.foreground }]} numberOfLines={1}>
                  {safeName(row.payee, "No payee")}
                </Text>
                <Text style={[styles.amount, { color: row.amount < 0 ? colors.foreground : colors.pos }]}>
                  {formatCurrency(row.amount, row.currency || bound?.currency || "USD")}
                </Text>
              </View>
              <Text style={[styles.meta, { color: colors.mutedForeground }]}>
                {row.date}
                {row.isDuplicate ? " · already recorded" : ""}
              </Text>
            </View>
          );
        }}
      />
      <PickerSheet
        visible={pickAccount}
        title="Account"
        options={accountOptions}
        selectedId={boundId}
        onSelect={(accountId) => bind(accountId)}
        onClose={() => setPickAccount(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  header: { flex: 1, fontSize: 22, fontWeight: "800" },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  select: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  counts: { fontSize: 13, marginTop: 10 },
  primary: { marginTop: 14, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  discard: { alignItems: "center", paddingTop: 12 },
  row: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  payee: { flex: 1, fontSize: 14, fontWeight: "600", marginRight: 8 },
  amount: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  meta: { fontSize: 12, marginTop: 2 },
  error: { fontSize: 14, marginBottom: 8 },
});
