import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { useAuth } from "../hooks/useAuth";
import { getServerUrl, setServerUrl } from "../api/client";

export default function SettingsScreen() {
  const theme = useTheme();
  const { lock } = useAuth();
  const [url, setUrl] = useState(getServerUrl());
  const [saved, setSaved] = useState(false);

  const colors = theme.colors;

  const handleSaveUrl = () => {
    setServerUrl(url);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleLock = () => {
    Alert.alert("Lock App", "Are you sure you want to lock the app?", [
      { text: "Cancel", style: "cancel" },
      { text: "Lock", style: "destructive", onPress: lock },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.header, { color: colors.foreground }]}>Settings</Text>

        {/* Server URL */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>Server URL</Text>
          <TextInput
            style={[
              styles.input,
              { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border },
            ]}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://localhost:3000"
            placeholderTextColor={colors.mutedForeground}
          />
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.primary }]}
            onPress={handleSaveUrl}
          >
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
              {saved ? "Saved!" : "Save"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Lock */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>Security</Text>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.destructive }]}
            onPress={handleLock}
          >
            <Text style={[styles.buttonText, { color: colors.destructiveForeground }]}>
              Lock App
            </Text>
          </TouchableOpacity>
        </View>

        {/* App info */}
        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            PF Mobile v1.0.0
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 16, paddingBottom: 32 },
  header: { fontSize: 28, fontWeight: "800", marginBottom: 16 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
  label: { fontSize: 13, fontWeight: "600", marginBottom: 8 },
  input: {
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  button: {
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 15, fontWeight: "600" },
  footer: { alignItems: "center", paddingVertical: 32 },
  footerText: { fontSize: 13 },
});
