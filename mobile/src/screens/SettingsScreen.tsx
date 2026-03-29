import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { useAuth } from "../hooks/useAuth";
import { getServerUrl, setServerUrl } from "../api/client";

const AUTO_LOCK_OPTIONS = [
  { label: "Disabled", value: 0 },
  { label: "1 min", value: 1 },
  { label: "5 min", value: 5 },
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
];

export default function SettingsScreen() {
  const theme = useTheme();
  const {
    lock,
    biometricAvailable,
    biometricEnabled,
    setBiometricEnabled,
    autoLockMinutes,
    setAutoLockMinutes,
  } = useAuth();
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

        {/* Server Connection */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>CONNECTION</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>Server URL</Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: colors.secondary,
                color: colors.foreground,
                borderColor: colors.border,
              },
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
              {saved ? "✓ Saved!" : "Save"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Security */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>SECURITY</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {/* Biometric */}
          {biometricAvailable && (
            <View style={[styles.settingRow, { borderBottomColor: colors.border }]}>
              <View style={styles.settingLeft}>
                <Text style={[styles.settingLabel, { color: colors.foreground }]}>
                  Biometric Unlock
                </Text>
                <Text style={[styles.settingDesc, { color: colors.mutedForeground }]}>
                  Use Face ID or fingerprint to unlock
                </Text>
              </View>
              <Switch
                value={biometricEnabled}
                onValueChange={setBiometricEnabled}
                trackColor={{ false: colors.secondary, true: colors.primary + "80" }}
                thumbColor={biometricEnabled ? colors.primary : colors.mutedForeground}
              />
            </View>
          )}

          {/* Auto-lock */}
          <View style={styles.settingSection}>
            <Text style={[styles.settingLabel, { color: colors.foreground }]}>
              Auto-Lock After
            </Text>
            <Text style={[styles.settingDesc, { color: colors.mutedForeground }]}>
              Automatically lock when app is in background
            </Text>
            <View style={styles.chipRow}>
              {AUTO_LOCK_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  onPress={() => setAutoLockMinutes(opt.value)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor:
                        autoLockMinutes === opt.value ? colors.primary : colors.secondary,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      {
                        color:
                          autoLockMinutes === opt.value
                            ? colors.primaryForeground
                            : colors.foreground,
                      },
                    ]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Lock button */}
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.destructive, marginTop: 12 }]}
            onPress={handleLock}
          >
            <Text style={[styles.buttonText, { color: colors.destructiveForeground }]}>
              Lock App Now
            </Text>
          </TouchableOpacity>
        </View>

        {/* About */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>ABOUT</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.aboutRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.aboutLabel, { color: colors.mutedForeground }]}>App</Text>
            <Text style={[styles.aboutValue, { color: colors.foreground }]}>PF Mobile</Text>
          </View>
          <View style={[styles.aboutRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.aboutLabel, { color: colors.mutedForeground }]}>Version</Text>
            <Text style={[styles.aboutValue, { color: colors.foreground }]}>1.0.0</Text>
          </View>
          <View style={[styles.aboutRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.aboutLabel, { color: colors.mutedForeground }]}>Platform</Text>
            <Text style={[styles.aboutValue, { color: colors.foreground }]}>
              React Native + Expo
            </Text>
          </View>
          <View style={styles.aboutRow}>
            <Text style={[styles.aboutLabel, { color: colors.mutedForeground }]}>Server</Text>
            <Text style={[styles.aboutValue, { color: colors.foreground }]} numberOfLines={1}>
              {getServerUrl()}
            </Text>
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            Privacy-first personal finance
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
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 8,
    marginTop: 4,
    letterSpacing: 0.5,
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 16,
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
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  settingLeft: { flex: 1, marginRight: 12 },
  settingLabel: { fontSize: 15, fontWeight: "500" },
  settingDesc: { fontSize: 12, marginTop: 2 },
  settingSection: { paddingVertical: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { fontSize: 13, fontWeight: "500" },
  aboutRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  aboutLabel: { fontSize: 14 },
  aboutValue: { fontSize: 14, fontWeight: "500" },
  footer: { alignItems: "center", paddingVertical: 24 },
  footerText: { fontSize: 13 },
});
