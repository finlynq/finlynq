// AI guidance (FINLYNQ-219): the user's own notes, which an AI assistant
// connected to Finlynq reads before it starts, and Finlynq's guides. The phone
// take on the web's Settings → AI guidance page, over the same routes.
//
// Reloads on every focus so a note just saved or retired shows its new state.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { Icon } from "../components/icon";
import {
  GUIDANCE_INTRO,
  GUIDES_HINT,
  GUIDES_LOAD_ERROR,
  NOTES_EMPTY,
  NOTES_HINT,
  NOTES_LOAD_ERROR,
  NOTES_LOCKED,
  UNREADABLE,
  type GuideModule,
  type NoteSummary,
} from "../lib/guidance";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Tab = "notes" | "guides";

/** What went wrong with a load, for the log. */
function failure(r: PromiseSettledResult<{ success: boolean; error?: string }>): string {
  if (r.status === "rejected") return String(r.reason);
  return r.value.success ? "" : r.value.error ?? "";
}

export default function GuidanceScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList, "Guidance">>();
  const isFocused = useIsFocused();
  const [tab, setTab] = useState<Tab>("notes");
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [guides, setGuides] = useState<GuideModule[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [guidesError, setGuidesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setNotesError(null);
    setGuidesError(null);
    const [n, g] = await Promise.allSettled([endpoints.getGuidanceNotes(), endpoints.getGuides()]);
    if (!alive.current) return;
    if (n.status === "fulfilled" && n.value.success) {
      setLocked(!!n.value.data.locked);
      setNotes(n.value.data.notes ?? []);
    } else {
      logger.warn("guidance", "notes failed", { error: failure(n) });
      setNotesError(NOTES_LOAD_ERROR);
    }
    if (g.status === "fulfilled" && g.value.success) {
      setGuides(g.value.data.guides ?? []);
    } else {
      logger.warn("guidance", "guides failed", { error: failure(g) });
      setGuidesError(GUIDES_LOAD_ERROR);
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (isFocused) load();
  }, [isFocused, load]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Back">
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          AI guidance
        </Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      >
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>{GUIDANCE_INTRO}</Text>

        <View style={[styles.tabs, { backgroundColor: colors.muted }]} accessibilityRole="tablist">
          {(["notes", "guides"] as const).map((t) => {
            const on = tab === t;
            return (
              <TouchableOpacity
                key={t}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => setTab(t)}
                style={[styles.tab, on && { backgroundColor: colors.card }]}
              >
                <Text style={[styles.tabText, { color: on ? colors.foreground : colors.mutedForeground }]}>
                  {t === "notes" ? "Your notes" : "Finlynq guides"}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {tab === "notes" ? (
          <>
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>{NOTES_HINT}</Text>
            {locked ? (
              <Text style={[styles.body, { color: colors.foreground }]}>{NOTES_LOCKED}</Text>
            ) : notesError && !notes ? (
              <View accessibilityRole="alert">
                <Text style={[styles.body, { color: colors.destructive }]}>{notesError}</Text>
                <TouchableOpacity onPress={() => load()} accessibilityRole="button" style={styles.retry}>
                  <Text style={[styles.link, { color: colors.primary }]}>Try again</Text>
                </TouchableOpacity>
              </View>
            ) : !notes ? (
              <ActivityIndicator style={{ marginVertical: 32 }} size="large" color={colors.primary} />
            ) : (
              <>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="New note"
                  onPress={() => navigation.navigate("GuidanceNote", {})}
                  style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
                >
                  <Icon name="add" size={16} color={colors.primaryForeground} />
                  <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>New note</Text>
                </TouchableOpacity>
                {notes.length === 0 ? (
                  <Text style={[styles.body, { color: colors.mutedForeground }]}>{NOTES_EMPTY}</Text>
                ) : (
                  <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    {notes.map((n, i) => (
                      <TouchableOpacity
                        key={n.id}
                        accessibilityRole="button"
                        accessibilityLabel={n.unreadable ? UNREADABLE : n.title}
                        onPress={() => navigation.navigate("GuidanceNote", { id: n.id })}
                        style={[styles.row, i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
                      >
                        <View style={styles.rowMain}>
                          <View style={styles.rowTitleLine}>
                            <Text
                              style={[styles.rowTitle, { color: n.unreadable ? colors.mutedForeground : colors.foreground }]}
                              numberOfLines={1}
                            >
                              {n.unreadable ? UNREADABLE : n.title}
                            </Text>
                            {n.updatedBy === "assistant" ? (
                              <Text style={[styles.badge, { backgroundColor: colors.accent, color: colors.accentForeground }]}>
                                assistant
                              </Text>
                            ) : null}
                          </View>
                          {n.unreadable ? null : (
                            <Text style={[styles.rowPath, { color: colors.mutedForeground }]} numberOfLines={1}>
                              {n.path}
                            </Text>
                          )}
                          {n.summary && !n.unreadable ? (
                            <Text style={[styles.rowSummary, { color: colors.mutedForeground }]} numberOfLines={2}>
                              {n.summary}
                            </Text>
                          ) : null}
                        </View>
                        <Icon name="chevronRight" size={16} color={colors.mutedForeground} />
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>{GUIDES_HINT}</Text>
            {guidesError && !guides ? (
              <View accessibilityRole="alert">
                <Text style={[styles.body, { color: colors.destructive }]}>{guidesError}</Text>
                <TouchableOpacity onPress={() => load()} accessibilityRole="button" style={styles.retry}>
                  <Text style={[styles.link, { color: colors.primary }]}>Try again</Text>
                </TouchableOpacity>
              </View>
            ) : !guides ? (
              <ActivityIndicator style={{ marginVertical: 32 }} size="large" color={colors.primary} />
            ) : (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {guides.map((g, i) => (
                  <TouchableOpacity
                    key={g.id}
                    accessibilityRole="button"
                    accessibilityLabel={g.title}
                    onPress={() => navigation.navigate("Guide", { title: g.title, markdown: g.markdown })}
                    style={[styles.row, i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
                  >
                    <View style={styles.rowMain}>
                      <Text style={[styles.rowTitle, { color: colors.foreground }]}>{g.title}</Text>
                      <Text style={[styles.rowSummary, { color: colors.mutedForeground }]}>{g.summary}</Text>
                    </View>
                    <Icon name="chevronRight" size={16} color={colors.mutedForeground} />
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        )}
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
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { flexDirection: "row", alignItems: "center", gap: 2, width: 70 },
  backText: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  scroll: { padding: 16, paddingBottom: 32, gap: 12 },
  hint: { fontSize: 12, lineHeight: 17 },
  body: { fontSize: 14, lineHeight: 20 },
  retry: { marginTop: 4, alignSelf: "flex-start", paddingVertical: 6 },
  link: { fontSize: 14, fontWeight: "700" },
  tabs: { flexDirection: "row", borderRadius: 10, padding: 3 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8, minHeight: 36, justifyContent: "center" },
  tabText: { fontSize: 13, fontWeight: "700" },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 10,
    minHeight: 44,
  },
  primaryText: { fontSize: 15, fontWeight: "700" },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 12, minHeight: 52 },
  rowMain: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  rowPath: { fontSize: 12, fontFamily: "monospace" },
  rowSummary: { fontSize: 12, lineHeight: 17 },
  badge: { fontSize: 11, fontWeight: "700", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, overflow: "hidden" },
});
