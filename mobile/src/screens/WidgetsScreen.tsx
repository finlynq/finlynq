import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Switch,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useTheme } from "../theme";
import { Icon } from "../components/icon";
import { logger } from "../lib/logger";
import { parseSnapshot } from "../lib/widgets/snapshot";
import { syncWidgets, type WidgetSyncResult } from "../lib/widgets/sync";
import {
  canPinWidgets,
  getHideAmounts,
  pinWidget,
  readSnapshot,
  setHideAmounts,
  type WidgetKindKey,
} from "../../modules/finlynq-widgets";

const WIDGETS: { kind: WidgetKindKey; title: string; description: string }[] = [
  {
    kind: "leftToSpend",
    title: "Left to spend",
    description: "What is left of this month's spending budget, as a ring that empties as you spend, and the days to go.",
  },
  {
    kind: "upcoming",
    title: "Upcoming payments",
    description: "Your next bills, subscriptions and loan payments.",
  },
  {
    kind: "netWorth",
    title: "Net worth",
    description: "Your net worth, with assets and debts.",
  },
  {
    kind: "quickAdd",
    title: "Add transaction",
    description: "One tap to a new transaction.",
  },
];

export const WIDGETS_HOW_TO_ADD =
  "To add one, touch and hold your home screen, choose Widgets, then find Finlynq.";

export const WIDGETS_REFRESH_NOTE =
  "Widgets update when you open Finlynq and when you change something in it. They can't reach your data on their own, so once their figures are an hour old they say how old.";

function updatedLabel(ms: number | null | undefined): string {
  if (!ms) return "Not updated yet";
  return `Updated ${new Date(ms).toLocaleString()}`;
}

function refreshMessage(result: WidgetSyncResult): string | null {
  switch (result) {
    case "no-widgets":
      return "Add a widget first: there is nothing to update yet.";
    case "locked":
      return "Sign in again to update your widgets.";
    case "failed":
      return "Could not reach the server. Widgets keep showing the last figures.";
    default:
      return null;
  }
}

export default function WidgetsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation();
  const [hide, setHide] = useState(() => getHideAmounts());
  const [updatedAtMs, setUpdatedAtMs] = useState(() => parseSnapshot(readSnapshot())?.updatedAtMs ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canPin = canPinWidgets();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const toggleHide = useCallback((value: boolean) => {
    setHide(value);
    void setHideAmounts(value);
  }, []);

  const pin = useCallback((kind: WidgetKindKey) => {
    if (!pinWidget(kind)) setNote(WIDGETS_HOW_TO_ADD);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNote(null);
    let result: WidgetSyncResult = "failed";
    try {
      result = await syncWidgets({ force: true });
    } catch (e) {
      logger.warn("widgets", "refresh failed", { error: e instanceof Error ? e.name : "unknown" });
    }
    if (!alive.current) return;
    setRefreshing(false);
    setNote(refreshMessage(result));
    setUpdatedAtMs(parseSnapshot(readSnapshot())?.updatedAtMs ?? null);
  }, []);

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
          Widgets
        </Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {WIDGETS.map((w) => (
          <View key={w.kind} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{w.title}</Text>
            <Text style={[styles.body, { color: colors.mutedForeground }]}>{w.description}</Text>
            {canPin ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Add ${w.title} to home screen`}
                activeOpacity={0.7}
                onPress={() => pin(w.kind)}
                style={styles.linkBtn}
              >
                <Text style={[styles.linkText, { color: colors.primary }]}>Add to home screen</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
        {!canPin ? <Text style={[styles.footer, { color: colors.mutedForeground }]}>{WIDGETS_HOW_TO_ADD}</Text> : null}

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Hide amounts on widgets</Text>
              <Text style={[styles.body, { color: colors.mutedForeground }]}>
                Shows •••• instead of amounts, for anyone who can see your phone.
              </Text>
            </View>
            <Switch accessibilityLabel="Hide amounts on widgets" value={hide} onValueChange={toggleHide} />
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>{updatedLabel(updatedAtMs)}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Refresh widgets"
            accessibilityState={{ disabled: refreshing, busy: refreshing }}
            disabled={refreshing}
            activeOpacity={0.7}
            onPress={refreshing ? undefined : refresh}
            style={[styles.refreshBtn, { backgroundColor: colors.primary, opacity: refreshing ? 0.6 : 1 }]}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Icon name="refresh" size={16} color={colors.primaryForeground} />
            )}
            <Text style={[styles.refreshText, { color: colors.primaryForeground }]}>
              {refreshing ? "Refreshing…" : "Refresh now"}
            </Text>
          </TouchableOpacity>
          {note ? <Text style={[styles.note, { color: colors.destructive }]}>{note}</Text> : null}
        </View>

        <Text style={[styles.footer, { color: colors.mutedForeground }]}>{WIDGETS_REFRESH_NOTE}</Text>
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
  scroll: { padding: 16, paddingBottom: 32 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: "700", marginBottom: 4 },
  body: { fontSize: 13, lineHeight: 19 },
  linkBtn: { marginTop: 6, alignSelf: "flex-start", paddingVertical: 6 },
  linkText: { fontSize: 14, fontWeight: "700" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchText: { flex: 1 },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 10,
    paddingVertical: 11,
    marginTop: 10,
  },
  refreshText: { fontSize: 15, fontWeight: "700" },
  note: { fontSize: 12, lineHeight: 17, marginTop: 8 },
  footer: { fontSize: 12, lineHeight: 17, marginBottom: 12 },
});
