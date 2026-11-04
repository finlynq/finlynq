// Your feedback — the user's own threads, with a "New reply" marker (in-app
// feedback #30: replies could only be read by email or on the website).
//
// Same route as the web's /feedback page. Reloads on every focus so a thread
// just read loses its marker and one just sent appears.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { Icon } from "../components/icon";
import {
  FEEDBACK_EMPTY_TEXT,
  FEEDBACK_LIST_ERROR,
  FEEDBACK_LIST_HINT,
  feedbackStatusLabel,
  feedbackTypeLabel,
  replyCountLabel,
} from "../lib/feedback";
import { syncTimeLabel } from "../lib/bank-feed";
import type { Theme } from "../theme";
import type { FeedbackThreadSummary, FeedbackType } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

function typeBadgeColors(type: FeedbackType, colors: Theme["colors"]) {
  switch (type) {
    case "bug":
      return { bg: `${colors.destructive}26`, fg: colors.destructive };
    case "idea":
      return { bg: colors.accent, fg: colors.accentForeground };
    case "question":
      return { bg: `${colors.chart4}26`, fg: colors.chart4 };
    default:
      return { bg: colors.muted, fg: colors.mutedForeground };
  }
}

export default function FeedbackThreadsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList, "FeedbackThreads">>();
  const isFocused = useIsFocused();
  const [items, setItems] = useState<FeedbackThreadSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Ignore a response that lands after the screen is gone.
  const alive = useRef(true);
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
      const res = await endpoints.getFeedbackThreads();
      if (!alive.current) return;
      if (res.success) setItems(Array.isArray(res.data) ? res.data : []);
      else {
        logger.warn("feedback", "threads failed", { error: res.error });
        setLoadError(FEEDBACK_LIST_ERROR);
      }
    } catch (e) {
      logger.error("feedback", "threads threw", { detail: String(e) });
      if (alive.current) setLoadError(FEEDBACK_LIST_ERROR);
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isFocused) load();
  }, [isFocused, load]);

  const sendFeedback = (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Send feedback"
      activeOpacity={0.7}
      onPress={() => navigation.navigate("Feedback")}
      style={[styles.sendBtn, { backgroundColor: colors.primary }]}
    >
      <Text style={[styles.sendText, { color: colors.primaryForeground }]}>Send feedback</Text>
    </TouchableOpacity>
  );

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
          Your feedback
        </Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      >
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>{FEEDBACK_LIST_HINT}</Text>

        {loadError ? (
          <View accessibilityRole="alert" style={styles.errorBlock}>
            <Text style={[styles.body, { color: colors.destructive }]}>{loadError}</Text>
            <TouchableOpacity onPress={() => load()} accessibilityRole="button" style={styles.retry}>
              <Text style={[styles.retryText, { color: colors.primary }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {!items && !loadError ? (
          <ActivityIndicator style={{ marginVertical: 32 }} size="large" color={colors.primary} />
        ) : null}

        {items && items.length === 0 ? (
          <View style={[styles.card, styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.body, styles.emptyText, { color: colors.mutedForeground }]}>
              {FEEDBACK_EMPTY_TEXT}
            </Text>
            {sendFeedback}
          </View>
        ) : null}

        {items && items.length > 0 ? <View style={styles.sendRow}>{sendFeedback}</View> : null}

        {items?.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            onOpen={() => navigation.navigate("FeedbackThread", { id: t.id })}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function ThreadRow({ thread, onOpen }: { thread: FeedbackThreadSummary; onOpen: () => void }) {
  const { colors } = useTheme();
  const typeColors = typeBadgeColors(thread.type, colors);
  const replies = replyCountLabel(thread.messageCount);
  const typeLabel = feedbackTypeLabel(thread.type);
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`Open ${typeLabel} feedback${thread.unread ? ", new reply" : ""}`}
      activeOpacity={0.7}
      onPress={onOpen}
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={styles.badges}>
        <View style={[styles.badge, { backgroundColor: typeColors.bg }]}>
          <Text style={[styles.badgeText, { color: typeColors.fg }]}>{typeLabel}</Text>
        </View>
        <View style={[styles.badge, styles.outline, { borderColor: colors.border }]}>
          <Text style={[styles.badgeText, { color: colors.foreground }]}>
            {feedbackStatusLabel(thread.status)}
          </Text>
        </View>
        {thread.unread ? (
          <View style={[styles.badge, { backgroundColor: colors.primary }]}>
            <Text style={[styles.badgeText, { color: colors.primaryForeground }]}>New reply</Text>
          </View>
        ) : null}
      </View>
      <Text
        style={[
          styles.preview,
          { color: thread.unread ? colors.foreground : colors.mutedForeground },
          thread.unread && styles.previewUnread,
        ]}
        numberOfLines={2}
      >
        {thread.lastMessagePreview}
      </Text>
      <Text style={[styles.meta, { color: colors.mutedForeground }]}>
        {[syncTimeLabel(thread.lastMessageAt), replies].filter(Boolean).join(" · ")}
      </Text>
    </TouchableOpacity>
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
  hint: { fontSize: 13, lineHeight: 19, marginBottom: 12 },
  errorBlock: { marginBottom: 12 },
  body: { fontSize: 13, lineHeight: 19 },
  retry: { marginTop: 4, alignSelf: "flex-start", paddingVertical: 6 },
  retryText: { fontSize: 14, fontWeight: "700" },
  sendRow: { marginBottom: 12 },
  sendBtn: { alignItems: "center", borderRadius: 10, paddingVertical: 11, paddingHorizontal: 16 },
  sendText: { fontSize: 15, fontWeight: "700" },
  empty: { alignItems: "center", paddingVertical: 24 },
  emptyText: { marginBottom: 12, textAlign: "center" },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  badge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  outline: { borderWidth: StyleSheet.hairlineWidth },
  badgeText: { fontSize: 12, fontWeight: "600" },
  preview: { fontSize: 14, lineHeight: 20 },
  previewUnread: { fontWeight: "600" },
  meta: { fontSize: 12, marginTop: 6 },
});
