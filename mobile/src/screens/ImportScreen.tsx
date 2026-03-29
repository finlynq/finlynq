import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";

export default function ImportScreen() {
  const theme = useTheme();
  const colors = theme.colors;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <Text style={[styles.header, { color: colors.foreground }]}>Import</Text>
      <View style={styles.center}>
        <Text style={[styles.icon, { color: colors.mutedForeground }]}>{"↓"}</Text>
        <Text style={[styles.title, { color: colors.foreground }]}>Import Data</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Import CSV, OFX, or Excel files from your bank to add transactions.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { fontSize: 28, fontWeight: "800", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  icon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: "700", marginBottom: 8 },
  subtitle: { fontSize: 15, textAlign: "center", lineHeight: 22 },
});
