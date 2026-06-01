import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { CATEGORY_TYPES } from "../lib/constants";

type CategoryType = "E" | "I" | "R";

export default function AddCategoryScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();

  const [name, setName] = useState("");
  const [type, setType] = useState<CategoryType>("E");
  const [group, setGroup] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) {
      Alert.alert("Error", "Please enter a category name");
      return;
    }
    if (!group.trim()) {
      Alert.alert("Error", "Please enter a group (e.g. Food, Housing)");
      return;
    }
    setSaving(true);
    try {
      const res = await endpoints.createCategory({
        name: name.trim(),
        type,
        group: group.trim(),
        note: note.trim() || undefined,
      });
      if (res.success) {
        logger.info("add-category", "category created", { type });
        navigation.goBack();
      } else {
        logger.warn("add-category", "create rejected", { error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to create category");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("add-category", "create threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>Add Category</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.saveBtn, { color: colors.primary }]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {/* Name */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>NAME</Text>
              <TextInput
                style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                value={name}
                onChangeText={setName}
                placeholder="e.g. Groceries"
                placeholderTextColor={colors.mutedForeground}
                autoFocus
              />
            </View>

            {/* Type */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>TYPE</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={fieldStyles.chipRow}>
                {CATEGORY_TYPES.map((t) => {
                  const active = t.value === type;
                  return (
                    <TouchableOpacity
                      key={t.value}
                      onPress={() => setType(t.value)}
                      style={[
                        fieldStyles.chip,
                        {
                          backgroundColor: active ? colors.primary : colors.secondary,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          fieldStyles.chipText,
                          { color: active ? colors.primaryForeground : colors.foreground },
                        ]}
                      >
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            {/* Group (free text, required) */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>GROUP</Text>
              <TextInput
                style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                value={group}
                onChangeText={setGroup}
                placeholder="e.g. Food, Housing, Transport"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Note (optional) */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>NOTE (OPTIONAL)</Text>
              <TextInput
                style={[
                  fieldStyles.input,
                  { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border, minHeight: 60, textAlignVertical: "top" },
                ]}
                value={note}
                onChangeText={setNote}
                placeholder="Optional note"
                placeholderTextColor={colors.mutedForeground}
                multiline
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  saveBtn: { fontSize: 15, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 32 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
});

const fieldStyles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  input: {
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chipRow: { flexDirection: "row" },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 8,
  },
  chipText: { fontSize: 13, fontWeight: "500" },
});
