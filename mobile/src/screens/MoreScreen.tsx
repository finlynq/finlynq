import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { useAuth } from "../hooks/useAuth";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { Icon, type IconName } from "../components/icon";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Nav = NativeStackNavigationProp<MoreStackParamList, "MoreHome">;

interface Row {
  icon: IconName;
  label: string;
  onPress: () => void;
  danger?: boolean;
}

interface Section {
  title: string;
  rows: Row[];
}

export default function MoreScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();
  const { signOut } = useAuth();
  const [seedingSample, setSeedingSample] = useState(false);

  const confirmSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: signOut },
    ]);
  };

  const runLoadSampleData = async () => {
    setSeedingSample(true);
    try {
      const res = await endpoints.loadSampleData();
      if (res.success) {
        // The sample-data route returns `{ success, transactionsCreated }`
        // (no `.data` wrapper) — read the count off the top level.
        const created =
          (res as unknown as { transactionsCreated?: number }).transactionsCreated ?? 0;
        logger.info("more", "sample data loaded", { created });
        Alert.alert(
          "Sample data added",
          "Added starter accounts, categories" +
            (created > 0 ? ` and ${created} sample transactions` : "") +
            ". Pull to refresh your accounts and transactions."
        );
      } else {
        logger.warn("more", "sample data rejected", { error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to load sample data");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("more", "sample data threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSeedingSample(false);
    }
  };

  const confirmLoadSampleData = () => {
    if (seedingSample) return;
    Alert.alert(
      "Load sample data",
      "Add a few starter accounts, categories and example transactions so you can explore the app? You can delete them anytime.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Load", onPress: runLoadSampleData },
      ]
    );
  };

  const sections: Section[] = [
    {
      title: "Get started",
      rows: [
        {
          icon: "sampleData",
          label: seedingSample ? "Loading sample data…" : "Load sample data",
          onPress: confirmLoadSampleData,
        },
      ],
    },
    {
      title: "Add",
      rows: [
        {
          icon: "add",
          label: "Add transaction",
          onPress: () => navigation.navigate("AddTransaction", { mode: "expense" }),
        },
        {
          icon: "transfer",
          label: "Transfer",
          onPress: () => navigation.navigate("AddTransaction", { mode: "transfer" }),
        },
      ],
    },
    {
      title: "Tracking",
      rows: [
        { icon: "budgets", label: "Budgets", onPress: () => navigation.navigate("Budgets") },
        { icon: "goals", label: "Goals", onPress: () => navigation.navigate("Goals") },
        { icon: "reports", label: "Reports", onPress: () => navigation.navigate("Reports") },
        { icon: "inbox", label: "Reconcile", onPress: () => navigation.navigate("Inbox") },
        { icon: "categories", label: "Categories", onPress: () => navigation.navigate("Categories") },
        { icon: "import", label: "Import", onPress: () => navigation.navigate("Import") },
      ],
    },
    {
      title: "Tools",
      rows: [
        { icon: "whatsNew", label: "What's new", onPress: () => navigation.navigate("WhatsNew") },
        { icon: "settings", label: "Settings", onPress: () => navigation.navigate("Settings") },
        { icon: "feedback", label: "Send feedback", onPress: () => navigation.navigate("Feedback") },
        { icon: "logout", label: "Sign out", onPress: confirmSignOut, danger: true },
      ],
    },
  ];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.foreground }]}>More</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        {sections.map((section) => (
          <View key={section.title}>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
              {section.title.toUpperCase()}
            </Text>
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {section.rows.map((row, i) => (
                <TouchableOpacity
                  key={row.label}
                  activeOpacity={0.7}
                  onPress={row.onPress}
                  style={[
                    styles.row,
                    i < section.rows.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: colors.border,
                    },
                  ]}
                >
                  <View style={[styles.iconWrap, { backgroundColor: colors.secondary }]}>
                    <Icon
                      name={row.icon}
                      size={18}
                      color={row.danger ? colors.destructive : colors.foreground}
                    />
                  </View>
                  <Text
                    style={[
                      styles.rowLabel,
                      { color: row.danger ? colors.destructive : colors.foreground },
                    ]}
                  >
                    {row.label}
                  </Text>
                  {!row.danger && <Icon name="chevronRight" size={16} color={colors.mutedForeground} />}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}

        <Text style={[styles.webNote, { color: colors.mutedForeground }]}>
          Subscriptions & loans — manage on the web app.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  headerRow: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  header: { fontSize: 28, fontWeight: "800" },
  scroll: { padding: 16, paddingBottom: 32 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 8,
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  rowLabel: { flex: 1, fontSize: 15, fontWeight: "500" },
  webNote: { fontSize: 12, textAlign: "center", marginTop: 16, paddingHorizontal: 24, lineHeight: 18 },
});
