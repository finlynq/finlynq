// Email imports — every email sent to the import address, with a To record /
// Recorded switch (owner feedback 2026-10-15: one list of emails, filtered by
// whether there is still something to do, instead of "emails" beside
// "statement files").
//
// An email either describes one transaction (a bank alert: tap it to read the
// email and record it) or carries a statement file (tap it to send the file's
// rows to an account). Recorded emails open read-only. Same routes as the web's
// Email tab and /import/pending; opening this screen also runs the email rules'
// auto-record, as on web.

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
import { emailStatusLabel, splitEmails, type EmailListEntry } from "../lib/email-imports";
import type { EmailInboxItem, StagedImportSummary } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Tab = "toRecord" | "recorded";
type Row = { kind: "error"; message: string } | { kind: "email"; entry: EmailListEntry } | { kind: "none"; text: string };

export default function EmailImportsScreen() {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList, "EmailImports">>();
  const [emails, setEmails] = useState<EmailInboxItem[]>([]);
  const [files, setFiles] = useState<StagedImportSummary[]>([]);
  const [tab, setTab] = useState<Tab>("toRecord");
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

  // A statement file still waiting is one listed by GET /api/import/staged.
  const filesById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const split = useMemo(() => splitEmails(emails, new Set(filesById.keys())), [emails, filesById]);
  const shown = tab === "toRecord" ? split.toRecord : split.recorded;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (error) out.push({ kind: "error", message: error });
    for (const entry of shown) out.push({ kind: "email", entry });
    if (shown.length === 0) {
      out.push({
        kind: "none",
        text: tab === "toRecord" ? "Nothing to record. Every email has been dealt with." : "No recorded emails yet.",
      });
    }
    return out;
  }, [shown, tab, error]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const open = ({ item, status }: EmailListEntry) => {
    const title = safeName(item.subject, "(no subject)");
    if (status === "file_to_review" && item.stagedImportId) {
      navigation.navigate("StagedImport", { id: item.stagedImportId, title });
    } else {
      navigation.navigate("EmailRecord", { item });
    }
  };

  const renderEmail = (entry: EmailListEntry) => {
    const { item, status } = entry;
    const c = item.candidate;
    const file = item.stagedImportId ? filesById.get(item.stagedImportId) : undefined;
    const title = c ? safeName(c.payee, "Unknown payee") : safeName(item.subject, "(no subject)");
    const detail =
      status === "file_to_review" && file
        ? `Statement file · ${file.totalRowCount} ${file.totalRowCount === 1 ? "row" : "rows"}${
            file.duplicateCount > 0 ? `, ${file.duplicateCount} already recorded` : ""
          }`
        : c
          ? `${c.date} · ${safeName(item.subject ?? item.fromAddress, "(no subject)")}`
          : safeName(item.fromAddress, "unknown sender");
    const note = status === "to_record" ? (item.parseConfidence === "low" ? "Check the amount" : null) : emailStatusLabel(status);
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${note ?? "record it"}`}
        activeOpacity={0.7}
        onPress={() => open(entry)}
        style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.line}>
          <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>
            {title}
          </Text>
          {c ? (
            <Text style={[styles.amount, { color: c.amount < 0 ? colors.foreground : colors.pos }]}>
              {formatCurrency(c.amount, c.currency)}
            </Text>
          ) : (
            <Icon name="chevronRight" size={16} color={colors.mutedForeground} />
          )}
        </View>
        <Text style={[styles.meta, { color: colors.mutedForeground }]} numberOfLines={1}>
          {detail}
        </Text>
        {note ? (
          <Text
            style={[styles.note, { color: status === "to_record" || status === "unreadable" ? colors.destructive : colors.mutedForeground }]}
            numberOfLines={1}
          >
            {note}
          </Text>
        ) : null}
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
      <View style={[styles.segment, { backgroundColor: colors.secondary }]}>
        {(
          [
            ["toRecord", `To record (${split.toRecord.length})`],
            ["recorded", `Recorded (${split.recorded.length})`],
          ] as const
        ).map(([key, label]) => (
          <TouchableOpacity
            key={key}
            accessibilityRole="button"
            accessibilityState={{ selected: tab === key }}
            onPress={() => setTab(key)}
            style={[styles.segmentBtn, tab === key && { backgroundColor: colors.card }]}
          >
            <Text style={[styles.segmentText, { color: tab === key ? colors.foreground : colors.mutedForeground }]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r, i) => (r.kind === "email" ? r.entry.item.id : `${r.kind}-${i}`)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
        renderItem={({ item: r }) => {
          if (r.kind === "error") return <Text style={[styles.error, { color: colors.destructive }]}>{r.message}</Text>;
          if (r.kind === "none") return <Text style={[styles.none, { color: colors.mutedForeground }]}>{r.text}</Text>;
          return renderEmail(r.entry);
        }}
        ListFooterComponent={
          <Text style={[styles.footer, { color: colors.mutedForeground }]}>
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
  segment: { flexDirection: "row", borderRadius: 10, padding: 3, marginHorizontal: 16, marginBottom: 10 },
  segmentBtn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  segmentText: { fontSize: 14, fontWeight: "700" },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  none: { fontSize: 13, marginVertical: 12, textAlign: "center" },
  row: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 8 },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  name: { flex: 1, fontSize: 15, fontWeight: "600", marginRight: 8 },
  amount: { fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  meta: { fontSize: 12, marginTop: 2 },
  note: { fontSize: 12, marginTop: 2, fontWeight: "600" },
  error: { fontSize: 14, marginBottom: 8 },
  footer: { fontSize: 12, textAlign: "center", marginTop: 16, lineHeight: 18 },
});
