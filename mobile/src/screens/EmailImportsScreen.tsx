// Email imports — what came in through the import email address and still
// needs the user (owner request 2026-10-15: until now this was web-only).
//
// Two kinds of email land here:
//   - a bank-alert email whose body was read as one transaction: tap it to
//     pick the account and category (or transfer) and record it;
//   - an emailed statement file, staged like an upload: tap it to say which
//     account it is for and send its rows to that account's ledger.
// The same routes as the web's Email tab and /import/pending, so both stay in
// step. Opening this screen also runs the email rules' auto-record, as on web.

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
import { Icon } from "../components/icon";
import { emailsToRecord, stagedSourceLabel, stagedTitle } from "../lib/email-imports";
import type { EmailInboxItem, StagedImportSummary } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Row =
  | { kind: "error"; message: string; key: string }
  | { kind: "heading"; title: string; key: string }
  | { kind: "email"; item: EmailInboxItem }
  | { kind: "file"; item: StagedImportSummary }
  | { kind: "none"; text: string; key: string };

export default function EmailImportsScreen() {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList, "EmailImports">>();
  const [emails, setEmails] = useState<EmailInboxItem[]>([]);
  const [files, setFiles] = useState<StagedImportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [inbox, staged] = await Promise.all([endpoints.getEmailInbox(), endpoints.getStagedImports()]);
      if (inbox.success) setEmails(Array.isArray(inbox.data) ? inbox.data : []);
      if (staged.success) setFiles(Array.isArray(staged.data) ? staged.data : []);
      const failed = !inbox.success ? inbox : !staged.success ? staged : null;
      setError(failed && !failed.success ? failed.error : null);
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("email-imports", "load threw", { detail });
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isFocused) load();
  }, [isFocused, load]);

  const toRecord = useMemo(() => emailsToRecord(emails), [emails]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (error) out.push({ kind: "error", message: error, key: "error" });
    out.push({ kind: "heading", title: "Emails to record", key: "h-emails" });
    if (toRecord.length === 0) out.push({ kind: "none", text: "No emailed transactions waiting.", key: "n-emails" });
    for (const item of toRecord) out.push({ kind: "email", item });
    out.push({ kind: "heading", title: "Statement files", key: "h-files" });
    if (files.length === 0) out.push({ kind: "none", text: "No statement files waiting.", key: "n-files" });
    for (const item of files) out.push({ kind: "file", item });
    return out;
  }, [toRecord, files, error]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const renderEmail = (item: EmailInboxItem) => {
    const c = item.candidate!;
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${safeName(c.payee, "Email")}, record it`}
        activeOpacity={0.7}
        onPress={() => navigation.navigate("EmailRecord", { item })}
        style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.line}>
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {safeName(c.payee, "Unknown payee")}
          </Text>
          <Text style={[styles.amount, { color: c.amount < 0 ? colors.foreground : colors.pos }]}>
            {formatCurrency(c.amount, c.currency)}
          </Text>
        </View>
        <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
          {c.date} · {safeName(item.subject ?? item.fromAddress, "(no subject)")}
          {item.parseConfidence === "low" ? " · check the amount" : ""}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderFile = (item: StagedImportSummary) => {
    const title = stagedTitle(item);
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${title}, review it`}
        activeOpacity={0.7}
        onPress={() => navigation.navigate("StagedImport", { id: item.id, title })}
        style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.line}>
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {title}
          </Text>
          <Icon name="chevronRight" size={16} color={colors.mutedForeground} />
        </View>
        <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
          {stagedSourceLabel(item)} · {item.totalRowCount} {item.totalRowCount === 1 ? "row" : "rows"}
          {item.duplicateCount > 0 ? ` · ${item.duplicateCount} already recorded` : ""}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} accessibilityLabel="Back">
          <Icon name="back" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.header, { color: colors.foreground }]}>Email imports</Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === "email" || r.kind === "file" ? `${r.kind}-${r.item.id}` : r.key)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
        renderItem={({ item: r }) => {
          switch (r.kind) {
            case "error":
              return <Text style={[styles.error, { color: colors.destructive }]}>{r.message}</Text>;
            case "heading":
              return <Text style={[styles.section, { color: colors.mutedForeground }]}>{r.title.toUpperCase()}</Text>;
            case "none":
              return <Text style={[styles.none, { color: colors.mutedForeground }]}>{r.text}</Text>;
            case "email":
              return renderEmail(r.item);
            default:
              return renderFile(r.item);
          }
        }}
        ListFooterComponent={
          <Text style={[styles.note, { color: colors.mutedForeground }]}>
            Email rules and your import address are set up on the web app, under Settings → Import.
          </Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  header: { fontSize: 28, fontWeight: "800" },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  section: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginTop: 12, marginBottom: 8 },
  none: { fontSize: 13, marginBottom: 8 },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 8 },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  name: { flex: 1, fontSize: 15, fontWeight: "600", marginRight: 8 },
  amount: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  meta: { fontSize: 12, marginTop: 2 },
  error: { fontSize: 14, marginBottom: 8 },
  note: { fontSize: 12, textAlign: "center", marginTop: 16, lineHeight: 18 },
});
