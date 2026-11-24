/**
 * The phone's Payee field: a plain text box that suggests payees already used
 * as you type, like the web's PayeeInput. Typing a new payee works as before;
 * picking one calls `onPick` so the screen can fill an empty category with the
 * one last used for it. The x on a suggestion stops suggesting that payee.
 * Suggestions show only after typing, and load on first focus. The screen's
 * ScrollView needs keyboardShouldPersistTaps="handled".
 */
import React, { useMemo, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, type StyleProp, type TextStyle } from "react-native";
import { useTheme } from "../theme";
import { Icon } from "./icon";
import { usePayeeOptions } from "../hooks/useNameOptions";
import { suggestPayees, type PayeeOption } from "../lib/payee-suggest";

export function PayeeInput({
  value,
  onValueChange,
  onPick,
  placeholder = "Merchant or payee name",
  style,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onPick?: (payee: PayeeOption) => void;
  placeholder?: string;
  style?: StyleProp<TextStyle>;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const [everFocused, setEverFocused] = useState(false);
  const [typed, setTyped] = useState(false);
  const { options, forget } = usePayeeOptions(everFocused);
  const suggestions = useMemo(() => suggestPayees(options, value), [options, value]);
  const open = focused && typed && suggestions.length > 0;

  return (
    <View>
      <TextInput
        accessibilityLabel="Payee"
        value={value}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        style={style}
        onFocus={() => {
          setFocused(true);
          setEverFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          setTyped(false);
        }}
        onChangeText={(t) => {
          setTyped(true);
          onValueChange(t);
        }}
      />
      {open ? (
        <View style={[styles.list, { backgroundColor: colors.card, borderColor: colors.border }]} accessibilityRole="list">
          {suggestions.map((s, i) => (
            <View
              key={s.id}
              style={[styles.option, i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
            >
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Use payee ${s.name}`}
                style={styles.pick}
                onPress={() => {
                  if (onPick) onPick(s);
                  else onValueChange(s.name);
                  setTyped(false);
                }}
              >
                <Text style={[styles.optionText, { color: colors.foreground }]} numberOfLines={1}>
                  {s.name}
                </Text>
                <Text style={[styles.count, { color: colors.mutedForeground }]}>{s.count}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Stop suggesting ${s.name}`}
                hitSlop={8}
                style={styles.forget}
                onPress={() => forget(s.id)}
              >
                <Icon name="close" size={14} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: "hidden" },
  option: { flexDirection: "row", alignItems: "center", minHeight: 44 },
  pick: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, minHeight: 44 },
  optionText: { flex: 1, fontSize: 15 },
  count: { fontSize: 13 },
  forget: { paddingHorizontal: 12, minHeight: 44, justifyContent: "center" },
});
