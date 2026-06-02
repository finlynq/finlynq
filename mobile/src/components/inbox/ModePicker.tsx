// ModePicker — per-account reconciliation-mode picker. Three radio options
// (Auto-pilot / Approve-each / Manual review), each with a one-line sub-label +
// a gate-count badge. PATCHes /api/accounts/[id]/mode on Save and surfaces an
// inline confirmation. Mirrors web src/components/inbox/mode-picker.tsx.
//
// SHARED with the mobile Settings-expansion plan — keep it self-contained so
// either surface can import it without extra wiring.

import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import { endpoints } from "../../api/client";
import { logger } from "../../lib/logger";
import { MODE_META, MODE_ORDER, isMode } from "../../lib/inbox";
import type { AccountMode } from "../../../../shared/types";

export function ModePicker({
  accountId,
  initialMode,
  onSaved,
}: {
  accountId: number;
  initialMode: AccountMode;
  onSaved?: (mode: AccountMode) => void;
}) {
  const { colors } = useTheme();
  const [selected, setSelected] = useState<AccountMode>(initialMode);
  const [savedMode, setSavedMode] = useState<AccountMode>(initialMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = selected !== savedMode;

  const onSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await endpoints.setAccountMode(accountId, selected);
      if (res.success) {
        const newMode: AccountMode = isMode(res.data?.mode) ? res.data.mode : selected;
        setSavedMode(newMode);
        setSelected(newMode);
        logger.info("inbox", "account mode saved", { accountId, mode: newMode });
        onSaved?.(newMode);
      } else {
        logger.warn("inbox", "account mode save failed", { error: res.error });
        setError(res.error);
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("inbox", "account mode save threw", { detail });
      setError("Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      {MODE_ORDER.map((m) => {
        const cfg = MODE_META[m];
        const isSelected = m === selected;
        const isCurrent = m === savedMode;
        const tone = colors[cfg.tone];
        return (
          <TouchableOpacity
            key={m}
            activeOpacity={0.7}
            onPress={() => setSelected(m)}
            style={[
              styles.option,
              {
                borderColor: isSelected ? colors.foreground : colors.border,
                backgroundColor: isSelected ? colors.secondary : colors.card,
              },
            ]}
          >
            <View
              style={[
                styles.radio,
                { borderColor: isSelected ? colors.foreground : colors.mutedForeground },
              ]}
            >
              {isSelected && <View style={[styles.radioDot, { backgroundColor: colors.foreground }]} />}
            </View>
            <View style={styles.optionBody}>
              <View style={styles.optionHeader}>
                <Icon name={cfg.icon} size={15} color={tone} />
                <Text style={[styles.optionLabel, { color: colors.foreground }]}>{cfg.label}</Text>
                <View style={[styles.badge, { borderColor: colors.border }]}>
                  <Text style={[styles.badgeText, { color: colors.mutedForeground }]}>
                    {cfg.gates} {cfg.gates === 1 ? "gate" : "gates"}
                  </Text>
                </View>
                {isCurrent && (
                  <Text style={[styles.currentTag, { color: colors.mutedForeground }]}>CURRENT</Text>
                )}
              </View>
              <Text style={[styles.optionSub, { color: colors.mutedForeground }]}>
                {cfg.subLabel}
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}

      {error && <Text style={[styles.error, { color: colors.neg }]}>{error}</Text>}

      <View style={styles.saveRow}>
        <TouchableOpacity
          style={[
            styles.saveBtn,
            { backgroundColor: colors.primary },
            (!dirty || saving) && styles.disabled,
          ]}
          onPress={onSave}
          disabled={!dirty || saving}
        >
          <Text style={[styles.saveText, { color: colors.primaryForeground }]}>
            {saving ? "Saving…" : "Save mode"}
          </Text>
        </TouchableOpacity>
        {!dirty && !saving && (
          <View style={styles.savedHint}>
            <Icon name="check" size={14} color={colors.pos} />
            <Text style={[styles.savedHintText, { color: colors.pos }]}>Saved</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  radio: {
    marginTop: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: { width: 9, height: 9, borderRadius: 5 },
  optionBody: { flex: 1 },
  optionHeader: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  optionLabel: { fontSize: 14, fontWeight: "700" },
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  badgeText: { fontSize: 10, fontWeight: "600", fontVariant: ["tabular-nums"] },
  currentTag: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  optionSub: { fontSize: 12, marginTop: 4 },
  error: { fontSize: 12, marginBottom: 8 },
  saveRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4 },
  saveBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 8 },
  saveText: { fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  savedHint: { flexDirection: "row", alignItems: "center", gap: 4 },
  savedHintText: { fontSize: 12, fontWeight: "600" },
});
