import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { Icon } from "../components/icon";
import type { Announcement } from "../../../shared/types";

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export default function WhatsNewScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await endpoints.getAnnouncements();
      if (res.success) {
        const list = res.data ?? [];
        setItems(list);
        logger.info("whats-new", "loaded", { count: list.length });
        // Mark everything unread on this visit as read (fire-and-forget).
        for (const a of list) {
          if (!a.read) endpoints.markAnnouncementRead(a.id).catch(() => {});
        }
      } else {
        setError("error" in res ? res.error : "Failed to load");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("whats-new", "load threw", { detail });
      setError("Cannot connect to server");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={8}>
          <Icon name="back" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>What&apos;s New</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {!items && !error && (
          <ActivityIndicator style={{ marginTop: 32 }} color={colors.primary} />
        )}
        {error && <Text style={[styles.muted, { color: colors.destructive }]}>{error}</Text>}
        {items && items.length === 0 && !error && (
          <Text style={[styles.muted, { color: colors.mutedForeground }]}>
            No announcements yet. Check back soon.
          </Text>
        )}

        {items?.map((a) => (
          <View
            key={a.id}
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={styles.cardHead}>
              <Icon
                name="whatsNew"
                size={18}
                color={a.severity === "warning" ? "#f59e0b" : colors.primary}
              />
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>{a.title}</Text>
              {!a.read && <View style={[styles.dot, { backgroundColor: colors.primary }]} />}
            </View>
            <Text style={[styles.meta, { color: colors.mutedForeground }]}>
              {a.category.toUpperCase()} · {fmtDate(a.publishedAt ?? a.createdAt)}
            </Text>
            <Text style={[styles.body, { color: colors.mutedForeground }]}>{a.body}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 32 },
  muted: { fontSize: 14, textAlign: "center", marginTop: 24 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 10,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: "700", flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  meta: { fontSize: 11, fontWeight: "600", marginTop: 6 },
  body: { fontSize: 14, lineHeight: 20, marginTop: 6 },
});
