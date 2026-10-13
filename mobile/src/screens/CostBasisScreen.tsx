// Cost basis method — how the cost of holdings, and so their gains, is worked
// out: the simple average of every purchase, or advanced lot allocation.
//
// The same setting as the web's Settings → Investments card (GET/PUT
// /api/settings/lot-allocation). Reached from the note on the Portfolio tab
// and from Settings, so it is registered in both stacks and only ever goes
// back. Changing which lots a sale used stays on the web app's Lot inspector.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { Icon } from "../components/icon";
import {
  COST_BASIS_ADVANCED_TEXT,
  COST_BASIS_EXAMPLE,
  COST_BASIS_METHODS,
  COST_BASIS_SIMPLE_TEXT,
  COST_BASIS_SWITCH_TEXT,
  costBasisMismatchNote,
  costBasisSavedNote,
} from "../lib/portfolio/cost-basis";
import type { LotAllocationStatus } from "../../../shared/types";

const NETWORK_ERROR = "Cannot connect to server";

export default function CostBasisScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();
  const [status, setStatus] = useState<LotAllocationStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Ignore a response that lands after the screen is gone.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await endpoints.getLotAllocation();
      if (!alive.current) return;
      if (res.success) setStatus(res.data);
      else {
        logger.warn("cost-basis", "load failed", { error: res.error });
        setLoadError(res.error);
      }
    } catch (e) {
      logger.error("cost-basis", "load threw", { detail: String(e) });
      if (alive.current) setLoadError(NETWORK_ERROR);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const choose = useCallback(
    async (enabled: boolean) => {
      // One switch at a time, and tapping the method already in use does nothing.
      if (saving || !status || status.enabled === enabled) return;
      setSaving(true);
      setSaveError(null);
      setNote(null);
      try {
        const res = await endpoints.setLotAllocation(enabled);
        if (!alive.current) return;
        if (res.success) {
          setStatus(res.data);
          setNote(costBasisSavedNote(res.data.enabled, res.data.rebuilt));
        } else {
          logger.warn("cost-basis", "save failed", { error: res.error });
          setSaveError(res.error);
        }
      } catch (e) {
        logger.error("cost-basis", "save threw", { detail: String(e) });
        if (alive.current) setSaveError("Could not reach the server. Nothing was changed.");
      } finally {
        if (alive.current) setSaving(false);
      }
    },
    [saving, status],
  );

  const mismatch = status ? costBasisMismatchNote(status.enabled, status.mismatched) : null;

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
          Cost basis method
        </Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.lead, { color: colors.mutedForeground }]}>
          How the cost of your holdings, and so their gains, is worked out.
        </Text>

        {loadError && !status ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.body, { color: colors.destructive }]}>{loadError}</Text>
            <Text style={[styles.body, { color: colors.mutedForeground, marginTop: 6 }]}>
              Choosing a method needs a current Finlynq server.
            </Text>
            <TouchableOpacity onPress={load} accessibilityRole="button" style={styles.retry}>
              <Text style={[styles.retryText, { color: colors.primary }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : !status ? (
          <ActivityIndicator style={{ marginVertical: 32 }} size="large" color={colors.primary} />
        ) : (
          <>
            {COST_BASIS_METHODS.map((m) => {
              const active = status.enabled === m.enabled;
              return (
                <TouchableOpacity
                  key={m.name}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: saving }}
                  disabled={saving}
                  activeOpacity={0.7}
                  onPress={() => choose(m.enabled)}
                  style={[
                    styles.option,
                    {
                      backgroundColor: colors.card,
                      borderColor: active ? colors.primary : colors.border,
                      borderWidth: active ? 1.5 : StyleSheet.hairlineWidth,
                      opacity: saving ? 0.6 : 1,
                    },
                  ]}
                >
                  <View style={styles.optionTop}>
                    <Text style={[styles.optionName, { color: colors.foreground }]}>{m.name}</Text>
                    {active ? <Text style={[styles.inUse, { color: colors.primary }]}>In use</Text> : null}
                  </View>
                  <Text style={[styles.optionSummary, { color: colors.mutedForeground }]}>{m.summary}</Text>
                </TouchableOpacity>
              );
            })}

            {saving ? <Text style={[styles.body, { color: colors.mutedForeground }]}>Saving…</Text> : null}
            {note ? <Text style={[styles.body, { color: colors.pos }]}>{note}</Text> : null}
            {saveError ? <Text style={[styles.body, { color: colors.destructive }]}>{saveError}</Text> : null}
            {mismatch ? (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.body, { color: colors.foreground }]}>{mismatch}</Text>
              </View>
            ) : null}
          </>
        )}

        <Text style={[styles.heading, { color: colors.foreground }]}>Simple (the default)</Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>{COST_BASIS_SIMPLE_TEXT}</Text>

        <Text style={[styles.heading, { color: colors.foreground }]}>Advanced lot allocation</Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>{COST_BASIS_ADVANCED_TEXT}</Text>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 16 }]}>
          <Text style={[styles.heading, { color: colors.foreground, marginTop: 0 }]}>Example</Text>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>{COST_BASIS_EXAMPLE.setup}</Text>
          {COST_BASIS_EXAMPLE.rows.map((r) => (
            <View key={r.method} style={styles.exampleRow}>
              <View style={styles.exampleTop}>
                <Text style={[styles.exampleMethod, { color: colors.foreground }]}>{r.method}</Text>
                <Text style={[styles.exampleValue, { color: colors.foreground }]}>{r.value}</Text>
              </View>
              <Text style={[styles.exampleWhy, { color: colors.mutedForeground }]}>{r.why}</Text>
            </View>
          ))}
        </View>

        <Text style={[styles.body, { color: colors.mutedForeground }]}>{COST_BASIS_SWITCH_TEXT}</Text>
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
  lead: { fontSize: 13, marginBottom: 12, lineHeight: 18 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 12 },
  option: { borderRadius: 12, padding: 14, marginBottom: 10 },
  optionTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  optionName: { fontSize: 15, fontWeight: "700", flex: 1, marginRight: 8 },
  inUse: { fontSize: 12, fontWeight: "700" },
  optionSummary: { fontSize: 13, marginTop: 4, lineHeight: 18 },
  heading: { fontSize: 14, fontWeight: "700", marginTop: 16, marginBottom: 4 },
  body: { fontSize: 13, lineHeight: 19, marginBottom: 8 },
  retry: { marginTop: 8, alignSelf: "flex-start", paddingVertical: 6 },
  retryText: { fontSize: 14, fontWeight: "700" },
  exampleRow: { marginTop: 10 },
  exampleTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  exampleMethod: { fontSize: 13, fontWeight: "600", flex: 1, marginRight: 8 },
  exampleValue: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  exampleWhy: { fontSize: 12, marginTop: 2, lineHeight: 17 },
});
