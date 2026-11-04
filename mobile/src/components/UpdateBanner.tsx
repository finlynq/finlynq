import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { useTheme } from "../theme";

/** Shown on Home when the store has a newer release. "Not now" lasts until the next one. */
export function UpdateBanner() {
  const { colors } = useTheme();
  const { update, dismiss, openStore } = useAppUpdate();
  if (!update) return null;

  return (
    <View style={[styles.banner, { backgroundColor: colors.card, borderColor: colors.primary }]}>
      <Text style={[styles.title, { color: colors.foreground }]}>Update available</Text>
      <Text style={[styles.body, { color: colors.mutedForeground }]}>
        A new version of Finlynq is ready in {update.storeName}.
      </Text>
      <View style={styles.actions}>
        <TouchableOpacity style={styles.button} onPress={dismiss} accessibilityRole="button">
          <Text style={[styles.buttonText, { color: colors.mutedForeground }]}>Not now</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={openStore}
          accessibilityRole="button"
        >
          <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>Update</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { borderRadius: 12, borderWidth: 1, padding: 12, marginBottom: 12 },
  title: { fontSize: 14, fontWeight: "700", marginBottom: 2 },
  body: { fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 10 },
  button: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  buttonText: { fontSize: 13, fontWeight: "700" },
});
