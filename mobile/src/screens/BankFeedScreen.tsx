// Bank feed — sync SimpleFIN from the phone (in-app feedback 2026-10-30: the
// phone app had no way to pull fresh bank data, so it always lagged).
//
// Same routes as the web's Settings → Bank feeds page: GET .../status, then
// "Sync now" = POST .../sync with no choices, so only the accounts already
// linked on the web are pulled. A bank account that is not linked yet is
// named and pointed at the web (owner decision 2026-10-30), as is connecting
// the feed. After a sync each account says where its new rows are waiting
// (review, Reconcile, or recorded by rules) and the sync's problems are
// listed as SimpleFIN worded them, like the web page.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { Icon } from "../components/icon";
import {
  BANK_FEED_NOT_CONNECTED_TEXT,
  BANK_FEED_TIMING_TEXT,
  SIMPLEFIN_BRIDGE_URL,
  SYNC_PROBLEMS_HELP_TEXT,
  lastSyncLine,
  lastSyncProblemNote,
  problemsHeading,
  summarizeSync,
  type SyncSummary,
  type SyncTarget,
} from "../lib/bank-feed";
import type { SimplefinStatus } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

const NETWORK_ERROR = "Cannot connect to server";

export default function BankFeedScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList, "BankFeed">>();
  const [status, setStatus] = useState<SimplefinStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  // Ignore a response that lands after the screen is gone.
  const alive = useRef(true);
  // The flag a double tap reads before the re-render that disables the button.
  const syncingRef = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setLoadError(null);
    try {
      const res = await endpoints.getBankFeedStatus();
      if (!alive.current) return;
      if (res.success) setStatus(res.data);
      else {
        logger.warn("bank-feed", "status failed", { error: res.error });
        setLoadError(res.error);
      }
    } catch (e) {
      logger.error("bank-feed", "status threw", { detail: String(e) });
      if (alive.current) setLoadError(NETWORK_ERROR);
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncError(null);
    setSummary(null);
    try {
      const res = await endpoints.syncBankFeed();
      if (!alive.current) return;
      if (res.success) {
        setSummary(summarizeSync(res.data));
      } else {
        logger.warn("bank-feed", "sync failed", { error: res.error });
        setSyncError(res.error);
      }
      // The stored outcome and "Last synced" moved either way (a 400 also
      // means the feed was disconnected on the web meanwhile).
      await load();
    } catch (e) {
      logger.error("bank-feed", "sync threw", { detail: String(e) });
      if (alive.current) setSyncError("Could not reach the server. Try again in a moment.");
    } finally {
      syncingRef.current = false;
      if (alive.current) setSyncing(false);
    }
  }, [load]);

  const open = (t: SyncTarget) => {
    if (t.screen === "StagedImport") navigation.navigate("StagedImport", { id: t.id, title: t.title });
    else navigation.navigate("Inbox", { accountId: t.accountId });
  };

  const problemNote = status?.connected && !summary ? lastSyncProblemNote(status.lastSync) : null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={styles.back}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          Bank feed
        </Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      >
        {loadError && !status ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.body, { color: colors.destructive }]}>{loadError}</Text>
            <TouchableOpacity onPress={() => load()} accessibilityRole="button" style={styles.retry}>
              <Text style={[styles.retryText, { color: colors.primary }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : !status ? (
          <ActivityIndicator style={{ marginVertical: 32 }} size="large" color={colors.primary} />
        ) : !status.connected ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>SimpleFIN</Text>
            <Text style={[styles.body, { color: colors.mutedForeground }]}>{BANK_FEED_NOT_CONNECTED_TEXT}</Text>
            {syncError ? <Text style={[styles.body, { color: colors.destructive }]}>{syncError}</Text> : null}
          </View>
        ) : (
          <>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.cardTop}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>SimpleFIN</Text>
                <Text style={[styles.connected, { color: colors.pos }]}>Connected</Text>
              </View>
              <Text style={[styles.body, { color: colors.mutedForeground }]}>{lastSyncLine(status)}</Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Sync now"
                accessibilityState={{ disabled: syncing, busy: syncing }}
                disabled={syncing}
                activeOpacity={0.7}
                onPress={syncing ? undefined : sync}
                style={[styles.syncBtn, { backgroundColor: colors.primary, opacity: syncing ? 0.6 : 1 }]}
              >
                {syncing ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Icon name="refresh" size={16} color={colors.primaryForeground} />
                )}
                <Text style={[styles.syncText, { color: colors.primaryForeground }]}>
                  {syncing ? "Syncing…" : "Sync now"}
                </Text>
              </TouchableOpacity>
              {syncing ? (
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  This can take up to a minute while SimpleFIN answers.
                </Text>
              ) : null}
            </View>

            {problemNote ? (
              <View style={[styles.card, { backgroundColor: colors.accent, borderColor: colors.primary }]}>
                <Text style={[styles.body, { color: colors.accentForeground }]}>{problemNote}</Text>
              </View>
            ) : null}

            {syncError ? <Text style={[styles.body, { color: colors.destructive }]}>{syncError}</Text> : null}

            {summary ? <SyncResult summary={summary} onOpen={open} /> : null}
          </>
        )}

        <Text style={[styles.footer, { color: colors.mutedForeground }]}>{BANK_FEED_TIMING_TEXT}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SyncResult({ summary, onOpen }: { summary: SyncSummary; onOpen: (t: SyncTarget) => void }) {
  const { colors } = useTheme();
  return (
    <>
      {summary.problems.length > 0 ? (
        <View accessibilityRole="alert" style={[styles.card, { backgroundColor: colors.accent, borderColor: colors.primary }]}>
          <Text style={[styles.cardTitle, { color: colors.accentForeground }]}>
            {problemsHeading(summary.problems.length)}
          </Text>
          {summary.problems.map((p, i) => (
            <Text key={i} style={[styles.body, { color: colors.accentForeground }]}>
              • {p}
            </Text>
          ))}
          <Text style={[styles.body, { color: colors.accentForeground }]}>{SYNC_PROBLEMS_HELP_TEXT}</Text>
          <TouchableOpacity
            accessibilityRole="link"
            onPress={() => Linking.openURL(SIMPLEFIN_BRIDGE_URL)}
            style={styles.retry}
          >
            <Text style={[styles.retryText, { color: colors.primary }]}>Open simplefin.org</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.foreground }]}>{summary.headline}</Text>
        {summary.accounts.map((a) => (
          <View key={a.accountId} style={[styles.accountRow, { borderTopColor: colors.border }]}>
            <View style={styles.accountText}>
              <Text style={[styles.accountName, { color: colors.foreground }]} numberOfLines={1}>
                {a.accountName}
              </Text>
              <Text style={[styles.accountDetail, { color: colors.mutedForeground }]}>{a.text}</Text>
            </View>
            {a.target ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`${a.target.label} ${a.accountName}`}
                onPress={() => a.target && onOpen(a.target)}
                hitSlop={8}
                style={styles.accountAction}
              >
                <Text style={[styles.retryText, { color: colors.primary }]}>{a.target.label}</Text>
                <Icon name="chevronRight" size={14} color={colors.primary} />
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
        {summary.newAccounts ? (
          <Text style={[styles.body, { color: colors.foreground, marginTop: 10 }]}>{summary.newAccounts}</Text>
        ) : null}
        {summary.pendingNote ? (
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>{summary.pendingNote}</Text>
        ) : null}
      </View>
    </>
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
  title: { fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  scroll: { padding: 16, paddingBottom: 32 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  cardTitle: { fontSize: 15, fontWeight: "700", marginBottom: 6 },
  connected: { fontSize: 12, fontWeight: "700" },
  body: { fontSize: 13, lineHeight: 19, marginBottom: 6 },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  syncBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 10,
    paddingVertical: 11,
    marginTop: 6,
  },
  syncText: { fontSize: 15, fontWeight: "700" },
  retry: { marginTop: 4, alignSelf: "flex-start", paddingVertical: 6 },
  retryText: { fontSize: 14, fontWeight: "700" },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  accountText: { flex: 1, marginRight: 8 },
  accountName: { fontSize: 14, fontWeight: "600" },
  accountDetail: { fontSize: 12, marginTop: 2, lineHeight: 17 },
  accountAction: { flexDirection: "row", alignItems: "center", gap: 2 },
  footer: { fontSize: 12, lineHeight: 17, marginTop: 8 },
});
