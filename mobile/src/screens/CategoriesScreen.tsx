import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  SectionList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { safeName } from "../lib/format";
import { Icon } from "../components/icon";
import type { Category } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Nav = NativeStackNavigationProp<MoreStackParamList, "Categories">;

const TYPE_LABEL: Record<string, string> = {
  E: "Expense",
  I: "Income",
  R: "Reconciliation",
};

interface Section {
  title: string;
  data: Category[];
}

function groupCategories(categories: Category[]): Section[] {
  const groups = new Map<string, Category[]>();
  for (const c of categories) {
    const key = c.group || "Other";
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  return Array.from(groups.entries())
    .map(([title, data]) => ({
      title,
      data: data.sort((a, z) => safeName(a.name).localeCompare(safeName(z.name))),
    }))
    .sort((a, z) => a.title.localeCompare(z.title));
}

export default function CategoriesScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();
  const isFocused = useIsFocused();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCategories = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await endpoints.getCategories();
      if (res.success) {
        setCategories(res.data);
        setError(null);
      } else {
        logger.warn("categories", "fetch failed", { error: res.error });
        setError(res.error);
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("categories", "fetch threw", { detail });
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Refetch on focus so a category created via the AddCategory modal appears
  // immediately on return.
  useEffect(() => {
    if (isFocused) fetchCategories();
  }, [isFocused, fetchCategories]);

  const sections = groupCategories(categories);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>Categories</Text>
        <TouchableOpacity
          style={[styles.addSmallBtn, { backgroundColor: colors.primary }]}
          onPress={() => navigation.navigate("AddCategory")}
        >
          <Text style={[styles.addSmallBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.destructive }}>{error}</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => fetchCategories(true)} />
          }
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>
              {section.title}
            </Text>
          )}
          renderItem={({ item }) => (
            <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={[styles.iconWrap, { backgroundColor: colors.secondary }]}>
                <Icon name="categories" size={18} color={colors.mutedForeground} />
              </View>
              <View style={styles.rowText}>
                <Text style={[styles.catName, { color: colors.foreground }]} numberOfLines={1}>
                  {safeName(item.name)}
                </Text>
                <Text style={[styles.catMeta, { color: colors.mutedForeground }]}>
                  {TYPE_LABEL[item.type] ?? item.type}
                </Text>
              </View>
            </View>
          )}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              No categories yet — tap “+ Add” to create one.
            </Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  header: { fontSize: 28, fontWeight: "800" },
  addSmallBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  addSmallBtnText: { fontSize: 14, fontWeight: "700" },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 8,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  rowText: { flex: 1 },
  catName: { fontSize: 15, fontWeight: "600" },
  catMeta: { fontSize: 12, marginTop: 2 },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14 },
});
