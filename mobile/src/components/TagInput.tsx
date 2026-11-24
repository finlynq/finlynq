/**
 * The phone's tag field: finished tags show as chips and the tags already in
 * use are suggested as you type, like the web's TagInput. The value is still
 * ONE comma-separated string ("a, b"), so nothing changes for the code that
 * saves it.
 *
 * A tag is finished by a comma, the keyboard's Done/Next, picking a
 * suggestion, or leaving the field. The x on a chip removes it. Suggestions
 * load on first focus. The screen's ScrollView needs
 * keyboardShouldPersistTaps="handled" so a suggestion takes the first tap.
 */
import React, { useMemo, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { Icon } from "./icon";
import { useTagOptions } from "../hooks/useNameOptions";
import { nearDuplicatesInValue, suggestTags, tagsInValue } from "../lib/tag-suggest";

const join = (tags: string[]) => tags.join(", ");

export function TagInput({
  value,
  onValueChange,
  placeholder = "Add tags",
  style,
  accessibilityLabel = "Tags",
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const [everFocused, setEverFocused] = useState(false);
  // The tag being typed. It is also the LAST tag of `value` (so a save made
  // mid-typing keeps it); when `value` changes from outside, they stop
  // matching and the draft is dropped.
  const [draftState, setDraftState] = useState("");
  const options = useTagOptions(everFocused);

  const all = tagsInValue(value);
  const draftLive = draftState.trim() !== "" && all[all.length - 1] === draftState.trim();
  const draft = draftLive ? draftState : "";
  const chips = draftLive ? all.slice(0, -1) : all;

  const emit = (nextChips: string[], nextDraft: string) => {
    setDraftState(nextDraft);
    onValueChange(join(nextDraft.trim() ? [...nextChips, nextDraft.trim()] : nextChips));
  };

  const virtual = chips.length ? `${join(chips)}, ${draft}` : draft;
  const suggestions = useMemo(() => suggestTags(options, virtual, 6), [options, virtual]);
  const near = nearDuplicatesInValue(options, join(chips));
  const nearSet = new Set(near.map((n) => n.typed));

  return (
    <View>
      <View
        style={[
          styles.box,
          { backgroundColor: colors.secondary, borderColor: focused ? colors.primary : colors.border },
          style,
        ]}
      >
        {chips.map((tag, i) => {
          const warn = nearSet.has(tag);
          return (
            <View
              key={`${tag}-${i}`}
              testID="tag-chip"
              style={[
                styles.chip,
                warn
                  ? { borderColor: colors.destructive, backgroundColor: colors.card }
                  : { borderColor: colors.primary, backgroundColor: colors.card },
              ]}
            >
              <Text style={[styles.chipText, { color: colors.foreground }]} numberOfLines={1}>
                {tag}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={`Remove tag ${tag}`}
                hitSlop={8}
                onPress={() => emit(chips.filter((_, j) => j !== i), draft)}
              >
                <Icon name="close" size={12} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          );
        })}
        <TextInput
          accessibilityLabel={accessibilityLabel}
          value={draft}
          placeholder={chips.length ? undefined : placeholder}
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          returnKeyType="done"
          style={[styles.input, { color: colors.foreground }]}
          onFocus={() => {
            setFocused(true);
            setEverFocused(true);
          }}
          onBlur={() => {
            setFocused(false);
            // Leaving the field finishes the tag in progress.
            setDraftState("");
          }}
          onChangeText={(text) => {
            if (text.includes(",")) {
              const parts = text.split(",");
              const rest = parts.pop() ?? "";
              emit([...chips, ...parts.map((p) => p.trim()).filter(Boolean)], rest.trimStart());
            } else {
              emit(chips, text);
            }
          }}
          onSubmitEditing={() => {
            if (draft.trim()) emit([...chips, draft.trim()], "");
          }}
        />
      </View>
      {focused && suggestions.length > 0 ? (
        <View style={[styles.list, { backgroundColor: colors.card, borderColor: colors.border }]} accessibilityRole="list">
          {suggestions.map((s, i) => (
            <TouchableOpacity
              key={s.tag}
              accessibilityRole="button"
              accessibilityLabel={`Add tag ${s.tag}`}
              onPress={() => emit([...chips, s.tag], "")}
              style={[styles.option, i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
            >
              <Text style={[styles.optionText, { color: colors.foreground }]} numberOfLines={1}>
                {s.tag}
              </Text>
              <Text style={[styles.count, { color: colors.mutedForeground }]}>{s.count}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      {near.length > 0 ? (
        <Text style={[styles.note, { color: colors.destructive }]}>
          {near.map((n) => `"${n.typed}" is close to your tag "${n.existing}".`).join(" ")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 44,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingLeft: 10,
    paddingRight: 8,
    paddingVertical: 4,
    maxWidth: "100%",
  },
  chipText: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  // Starts small and grows, so it sits on the chips' row when there is room.
  input: { flexGrow: 1, flexShrink: 1, flexBasis: 80, minWidth: 80, fontSize: 15, paddingVertical: 4, paddingHorizontal: 4 },
  list: { marginTop: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: "hidden" },
  option: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 44 },
  optionText: { flex: 1, fontSize: 15 },
  count: { fontSize: 13 },
  note: { fontSize: 12, lineHeight: 17, marginTop: 4 },
});
