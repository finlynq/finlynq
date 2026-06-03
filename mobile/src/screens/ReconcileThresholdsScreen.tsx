// Reconcile match thresholds editor (Settings → Reconciliation). Four numbers
// that tune the /reconcile fuzzy match-engine: how far apart a bank row and a
// transaction can be (days), the amount tolerance (% + absolute floor), and the
// overall match-score cutoff. GET on mount, PUT on save. The route is ENVELOPED
// ({ success, data: { thresholds, isDefault } }) — request() passes it through.
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { Icon } from "../components/icon";
import type { ReconcileThresholds } from "../../../shared/types";

interface FieldDef {
  key: keyof ReconcileThresholds;
  label: string;
  help: string;
  min: number;
  max: number;
  integer?: boolean;
  /** Display the stored 0–1 fraction as a 0–100 percent in the input. */
  asPercent?: boolean;
}

const FIELDS: FieldDef[] = [
  {
    key: "dateToleranceDays",
    label: "Date tolerance (days)",
    help: "How many days apart a bank row and a transaction can be and still match.",
    min: 0,
    max: 30,
    integer: true,
  },
  {
    key: "amountTolerancePct",
    label: "Amount tolerance (%)",
    help: "Percent the amounts may differ by, e.g. 7 = ±7%.",
    min: 0,
    max: 100,
    asPercent: true,
  },
  {
    key: "amountToleranceFloor",
    label: "Amount tolerance floor",
    help: "Minimum ± amount allowed regardless of the percentage (account currency).",
    min: 0,
    max: 10000,
  },
  {
    key: "scoreThreshold",
    label: "Match score threshold (0–1)",
    help: "Overall confidence cutoff; higher is stricter.",
    min: 0,
    max: 1,
  },
];

export default function ReconcileThresholdsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();

  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await endpoints.getReconcileThresholds();
        if (res.success && res.data?.thresholds) {
          setValues(toStrings(res.data.thresholds));
        } else if (!res.success) {
          logger.warn("thresholds", "fetch failed", { error: res.error });
          setError(res.error);
        }
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("thresholds", "fetch threw", { detail });
        setError("Cannot connect to server");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setField = (key: string, text: string) => {
    setSaved(false);
    // Allow digits, a single dot, and an empty string while typing.
    setValues((v) => ({ ...v, [key]: text.replace(/[^0-9.]/g, "") }));
  };

  const handleSave = async () => {
    // Parse + range-check every field; build the 0–1-fraction payload.
    const payload: Partial<ReconcileThresholds> = {};
    for (const f of FIELDS) {
      const raw = parseFloat(values[f.key] ?? "");
      if (isNaN(raw) || raw < f.min || raw > f.max) {
        setError(`${f.label} must be between ${f.min} and ${f.max}.`);
        return;
      }
      const stored = f.asPercent ? raw / 100 : raw;
      payload[f.key] = f.integer ? Math.round(stored) : stored;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await endpoints.setReconcileThresholds(payload as ReconcileThresholds);
      if (res.success) {
        logger.info("thresholds", "saved");
        if (res.data?.thresholds) setValues(toStrings(res.data.thresholds));
        setSaved(true);
      } else {
        logger.warn("thresholds", "save failed", { error: res.error });
        setError(res.error);
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("thresholds", "save threw", { detail });
      setError("Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Settings</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Match thresholds</Text>
        <View style={{ width: 64 }} />
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 32 }} size="large" color={colors.primary} />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={[styles.intro, { color: colors.mutedForeground }]}>
            Tune how the reconcile screen suggests matches between imported bank
            rows and your transactions.
          </Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {FIELDS.map((f) => (
              <View key={f.key} style={styles.field}>
                <Text style={[styles.label, { color: colors.foreground }]}>{f.label}</Text>
                <TextInput
                  style={[
                    styles.input,
                    { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border },
                  ]}
                  value={values[f.key] ?? ""}
                  onChangeText={(t) => setField(f.key, t)}
                  keyboardType="decimal-pad"
                  placeholder={String(f.min)}
                  placeholderTextColor={colors.mutedForeground}
                />
                <Text style={[styles.help, { color: colors.mutedForeground }]}>{f.help}</Text>
              </View>
            ))}
          </View>

          {error && <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>}

          <TouchableOpacity
            style={[styles.saveBtn, { backgroundColor: colors.primary }, saving && styles.disabled]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.saveText, { color: colors.primaryForeground }]}>
                {saved ? "✓ Saved" : "Save thresholds"}
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

/** Stored thresholds → input strings (percent fields scaled ×100). */
function toStrings(t: ReconcileThresholds): Record<string, string> {
  return {
    dateToleranceDays: String(t.dateToleranceDays),
    amountTolerancePct: String(Math.round(t.amountTolerancePct * 1000) / 10),
    amountToleranceFloor: String(t.amountToleranceFloor),
    scoreThreshold: String(t.scoreThreshold),
  };
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
  backBtn: { flexDirection: "row", alignItems: "center", gap: 2, width: 64 },
  backText: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 16, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 40 },
  intro: { fontSize: 13, lineHeight: 19, marginBottom: 16 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
  },
  field: { marginBottom: 18 },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 6 },
  input: {
    height: 44,
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  help: { fontSize: 12, marginTop: 6, lineHeight: 16 },
  error: { fontSize: 13, marginTop: 14 },
  saveBtn: {
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 20,
  },
  saveText: { fontSize: 15, fontWeight: "700" },
  disabled: { opacity: 0.6 },
});
