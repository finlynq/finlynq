import React, { useState, useEffect, useMemo } from "react";
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
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { CATEGORY_TYPES } from "../lib/constants";
import { categoryFormFromCategory } from "../lib/edit-prefill";
import type { Category } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type CategoryType = "E" | "I" | "R";

export default function AddCategoryScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();
  const route = useRoute<RouteProp<MoreStackParamList, "AddCategory">>();
  const editCategory = route.params?.category ?? null;
  const isEdit = !!editCategory;
  const init = useMemo(() => categoryFormFromCategory(editCategory), [editCategory]);

  const [name, setName] = useState(init.name);
  const [type, setType] = useState<CategoryType>(init.type);
  const [group, setGroup] = useState(init.group);
  const [note, setNote] = useState(init.note);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Existing categories drive the group suggestions. `group` is a plaintext
  // column (not encrypted), so values are usable directly. `customGroup` toggles
  // the free-text input that lets the user create a brand-new group.
  const [categories, setCategories] = useState<Category[]>([]);
  const [customGroup, setCustomGroup] = useState(false);

  useEffect(() => {
    endpoints
      .getCategories()
      .then((res) => {
        if (res.success) {
          setCategories(res.data);
          // No categories yet → nothing to pick from, start in "new group" mode.
          if (res.data.length === 0) setCustomGroup(true);
        } else {
          logger.warn("add-category", "categories fetch failed", { error: res.error });
          setCustomGroup(true);
        }
      })
      .catch((e) => {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("add-category", "categories load threw", { detail });
        setCustomGroup(true);
      });
  }, []);

  // Suggest groups that already exist for the selected category type.
  const existingGroups = useMemo(
    () =>
      [...new Set(categories.filter((c) => c.type === type).map((c) => c.group).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b)
      ),
    [categories, type]
  );

  const handleSave = async () => {
    if (!name.trim()) {
      Alert.alert("Error", "Please enter a category name");
      return;
    }
    if (!group.trim()) {
      Alert.alert("Error", "Please choose or enter a group (e.g. Food, Housing)");
      return;
    }
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        type,
        group: group.trim(),
        note: note.trim() || undefined,
      };
      const res =
        isEdit && editCategory
          ? await endpoints.updateCategory({ id: editCategory.id, ...fields })
          : await endpoints.createCategory(fields);
      if (res.success) {
        logger.info("add-category", isEdit ? "category updated" : "category created", { type });
        navigation.goBack();
      } else {
        logger.warn("add-category", "save rejected", { error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to save category");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("add-category", "save threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!editCategory) return;
    Alert.alert("Delete category?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setDeleting(true);
          try {
            const res = await endpoints.deleteCategory(editCategory.id);
            if (res.success) {
              logger.info("add-category", "category deleted", { id: editCategory.id });
              navigation.goBack();
            } else {
              // 409 when transactions still reference it — surface the message
              // ("Cannot delete: N transactions reference this category").
              logger.warn("add-category", "delete rejected", { error: res.error });
              Alert.alert("Can't delete category", res.error || "Reassign its transactions first (on the web app).");
            }
          } catch (e) {
            const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            logger.error("add-category", "delete threw", { detail });
            Alert.alert("Error", "Cannot connect to server");
          } finally {
            setDeleting(false);
          }
        },
      },
    ]);
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
          <Text style={[styles.title, { color: colors.foreground }]}>
            {isEdit ? "Edit Category" : "Add Category"}
          </Text>
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
                autoFocus={!isEdit}
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

            {/* Group — pick an existing group or create a new one (required) */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>GROUP</Text>
              <View style={fieldStyles.groupChips}>
                {existingGroups.map((g) => {
                  const active = !customGroup && group === g;
                  return (
                    <TouchableOpacity
                      key={g}
                      onPress={() => {
                        setCustomGroup(false);
                        setGroup(g);
                      }}
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
                        {g}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity
                  onPress={() => {
                    setCustomGroup(true);
                    setGroup("");
                  }}
                  style={[
                    fieldStyles.chip,
                    {
                      backgroundColor: customGroup ? colors.primary : colors.secondary,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      fieldStyles.chipText,
                      { color: customGroup ? colors.primaryForeground : colors.foreground },
                    ]}
                  >
                    + New group
                  </Text>
                </TouchableOpacity>
              </View>
              {customGroup && (
                <TextInput
                  style={[
                    fieldStyles.input,
                    { marginTop: 10, color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border },
                  ]}
                  value={group}
                  onChangeText={setGroup}
                  placeholder="e.g. Food, Housing, Transport"
                  placeholderTextColor={colors.mutedForeground}
                />
              )}
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

          {isEdit && (
            <TouchableOpacity
              style={[styles.deleteBtn, { borderColor: colors.destructive }]}
              onPress={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <ActivityIndicator size="small" color={colors.destructive} />
              ) : (
                <Text style={[styles.deleteText, { color: colors.destructive }]}>
                  Delete category
                </Text>
              )}
            </TouchableOpacity>
          )}
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
  deleteBtn: {
    height: 46,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  deleteText: { fontSize: 15, fontWeight: "700" },
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
  groupChips: { flexDirection: "row", flexWrap: "wrap", rowGap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 8,
  },
  chipText: { fontSize: 13, fontWeight: "500" },
});
