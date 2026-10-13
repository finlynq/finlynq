// Lightweight date-range control for the Reports filters: a row of preset
// chips (MTD/QTD/YTD/Last month/-quarter/-year/12mo/5 years/All time) + a "Custom" chip that
// opens a month-range modal (two scrollable month chip-rows). No date library
// — pure Date math lives in lib/reports/date-range.ts.
import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import { Icon } from "../icon";
import {
  RANGE_PRESETS,
  getPresetRange,
  recentMonths,
  monthStart,
  monthEnd,
  formatRangeLabel,
} from "../../lib/reports/date-range";

export interface RangeValue {
  preset: string;
  startDate: string;
  endDate: string;
}

interface Props {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
}

export function DateRangePicker({ value, onChange }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [modalOpen, setModalOpen] = useState(false);
  const months = recentMonths(24);

  // Custom-modal draft selection (seeded from the current range).
  const [draftStart, setDraftStart] = useState(value.startDate.slice(0, 7));
  const [draftEnd, setDraftEnd] = useState(value.endDate.slice(0, 7));

  const openCustom = () => {
    setDraftStart(value.startDate.slice(0, 7));
    setDraftEnd(value.endDate.slice(0, 7));
    setModalOpen(true);
  };

  const applyCustom = () => {
    // Guard against an inverted selection — swap so start ≤ end.
    let s = draftStart;
    let e = draftEnd;
    if (s > e) [s, e] = [e, s];
    onChange({ preset: "custom", startDate: monthStart(s), endDate: monthEnd(e) });
    setModalOpen(false);
  };

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {RANGE_PRESETS.map((p) => {
          const active = value.preset === p.key;
          return (
            <Chip
              key={p.key}
              label={p.label}
              active={active}
              onPress={() => {
                const r = getPresetRange(p.key);
                onChange({ preset: p.key, startDate: r.start, endDate: r.end });
              }}
            />
          );
        })}
        <Chip label="Custom" active={value.preset === "custom"} onPress={openCustom} />
      </ScrollView>

      {value.preset === "custom" && (
        <Text style={[styles.rangeLabel, { color: colors.mutedForeground }]}>
          {formatRangeLabel(value.startDate, value.endDate)}
        </Text>
      )}

      <Modal visible={modalOpen} animationType="slide" transparent onRequestClose={() => setModalOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setModalOpen(false)}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: colors.card, borderColor: colors.border, paddingTop: insets.top + 12 },
            ]}
            onPress={() => {}}
          >
            <View style={styles.headerRow}>
              <Text style={[styles.title, { color: colors.foreground }]}>Custom range</Text>
              <TouchableOpacity onPress={() => setModalOpen(false)} hitSlop={8}>
                <Icon name="close" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>FROM MONTH</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.monthRow}>
              {months.map((mo) => (
                <Chip
                  key={`s-${mo.value}`}
                  label={mo.label}
                  active={draftStart === mo.value}
                  onPress={() => setDraftStart(mo.value)}
                />
              ))}
            </ScrollView>

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>TO MONTH</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.monthRow}>
              {months.map((mo) => (
                <Chip
                  key={`e-${mo.value}`}
                  label={mo.label}
                  active={draftEnd === mo.value}
                  onPress={() => setDraftEnd(mo.value)}
                />
              ))}
            </ScrollView>

            <Text style={[styles.preview, { color: colors.mutedForeground }]}>
              {formatRangeLabel(
                monthStart(draftStart <= draftEnd ? draftStart : draftEnd),
                monthEnd(draftStart <= draftEnd ? draftEnd : draftStart)
              )}
            </Text>

            <TouchableOpacity
              style={[styles.applyBtn, { backgroundColor: colors.primary }]}
              onPress={applyCustom}
            >
              <Text style={[styles.applyText, { color: colors.primaryForeground }]}>Apply range</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? colors.primary : colors.secondary,
          borderColor: active ? colors.primary : colors.border,
        },
      ]}
    >
      <Text
        style={{
          color: active ? colors.primaryForeground : colors.foreground,
          fontSize: 13,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: "row", gap: 8, paddingVertical: 2, paddingRight: 8 },
  rangeLabel: { fontSize: 12, marginTop: 6, fontWeight: "500" },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-start" },
  sheet: {
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  title: { fontSize: 17, fontWeight: "700" },
  fieldLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginTop: 10, marginBottom: 8 },
  monthRow: { flexDirection: "row", gap: 8, paddingRight: 8 },
  preview: { fontSize: 13, marginTop: 14, textAlign: "center", fontWeight: "600" },
  applyBtn: {
    marginTop: 14,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  applyText: { fontSize: 15, fontWeight: "700" },
});
