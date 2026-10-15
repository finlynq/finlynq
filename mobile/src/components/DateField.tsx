// A date field that opens a month calendar instead of asking for typed
// `YYYY-MM-DD` (owner request 2026-10-15). The value stays a `YYYY-MM-DD`
// string, so screens that held a TextInput swap it for this without touching
// how they save. Pure JS (the shared MonthCalendar in an RN Modal), so it ships
// over the air with no native date-picker module.
import React, { useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../theme";
import { Icon } from "./icon";
import { MonthCalendar } from "./MonthCalendar";
import { isoDay, shiftYearMonth } from "../lib/month-calendar";
import { dateFieldLabel, pickerStartMonth } from "../lib/date-field";
import { localDateISO } from "../lib/subscriptions";

export interface DateFieldProps {
  /** `YYYY-MM-DD`, or "" for no date (only meaningful with `allowClear`). */
  value: string;
  onChange: (iso: string) => void;
  /** Heading inside the calendar, e.g. "Date" or "Deadline". */
  title?: string;
  /** Shown when there is no date. */
  placeholder?: string;
  /** Offer "No date" in the calendar (optional dates such as a goal deadline). */
  allowClear?: boolean;
  /** The field's box: pass the screen's own input style so it matches. */
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function DateField({
  value,
  onChange,
  title = "Pick a date",
  placeholder = "Pick a date",
  allowClear = false,
  style,
  accessibilityLabel,
}: DateFieldProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const today = localDateISO();
  const [shown, setShown] = useState(() => pickerStartMonth(value, today));

  const openPicker = () => {
    // Every open starts on the field's own month, not wherever it was left.
    setShown(pickerStartMonth(value, today));
    setOpen(true);
  };
  const pick = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };

  const label = dateFieldLabel(value);
  const selectedDay =
    label && value.slice(0, 7) === isoDay(shown.year, shown.month, 1).slice(0, 7) ? Number(value.slice(8, 10)) : null;

  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? `${title}: ${label ?? "none"}`}
        onPress={openPicker}
        style={[styles.field, style]}
      >
        <Text style={[styles.value, { color: label ? colors.foreground : colors.mutedForeground }]}>
          {label ?? placeholder}
        </Text>
        <Icon name="calendar" size={17} color={colors.mutedForeground} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => {}}
          >
            <View style={styles.headerRow}>
              <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={8} accessibilityLabel="Close">
                <Icon name="close" size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            <MonthCalendar
              year={shown.year}
              month={shown.month}
              today={today}
              selectedDay={selectedDay}
              // Tapping the chosen day again keeps it (MonthCalendar reports null).
              onSelectDay={(day) => pick(day == null ? value : isoDay(shown.year, shown.month, day))}
              onShiftMonth={(delta) => setShown((s) => shiftYearMonth(s.year, s.month, delta))}
              onToday={() => setShown(pickerStartMonth(today, today))}
              cellHeight={42}
            />
            <View style={styles.footer}>
              <TouchableOpacity onPress={() => setShown((s) => shiftYearMonth(s.year, s.month, -12))} hitSlop={6}>
                <Text style={[styles.footerLink, { color: colors.primary }]}>‹ Year</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => pick(today)} hitSlop={6}>
                <Text style={[styles.footerLink, { color: colors.primary }]}>Today</Text>
              </TouchableOpacity>
              {allowClear && (
                <TouchableOpacity onPress={() => pick("")} hitSlop={6}>
                  <Text style={[styles.footerLink, { color: colors.mutedForeground }]}>No date</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setShown((s) => shiftYearMonth(s.year, s.month, 12))} hitSlop={6}>
                <Text style={[styles.footerLink, { color: colors.primary }]}>Year ›</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  value: { fontSize: 15 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 16 },
  sheet: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  title: { fontSize: 17, fontWeight: "700" },
  footer: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 12 },
  footerLink: { fontSize: 14, fontWeight: "700" },
});
