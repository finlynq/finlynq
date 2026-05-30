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
import { useTheme, type ThemePreference } from "../theme";
import { useAuth } from "../hooks/useAuth";
import { getServerUrl } from "../api/client";
import { getLogs, clearLogs, type LogEntry, type LogLevel } from "../lib/logger";

const AUTO_LOCK_OPTIONS = [
  { label: "Disabled", value: 0 },
  { label: "1 min", value: 1 },
  { label: "5 min", value: 5 },
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
];

const THEME_OPTIONS: Array<{ label: string; value: ThemePreference }> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

export default function SettingsScreen() {
  const theme = useTheme();
  const {
    signOut,
    saveServerUrl,
    biometricAvailable,
    biometricEnabled,
    setBiometricEnabled,
    autoLockMinutes,
    setAutoLockMinutes,
    isAdmin,
  } = useAuth();
  const [url, setUrl] = useState(getServerUrl());
  const [saved, setSaved] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const colors = theme.colors;

  const logColor = (level: LogLevel): string =>
    level === "error"
      ? colors.destructive
      : level === "warn"
        ? colors.primary
        : colors.mutedForeground;

  const refreshLogs = () => setLogs(getLogs().slice(-80).reverse());
  const toggleLogs = () => {
    if (!showLogs) refreshLogs();
    setShowLogs((v) => !v);
  };
  const handleClearLogs = () => {
    clearLogs();
    setLogs([]);
  };

  function logTime(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  const handleSaveUrl = async () => {
    await saveServerUrl(url);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: signOut },
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

        {/* Appearance — Light / Dark / System theme selector. */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>APPEARANCE</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.settingLabel, { color: colors.foreground }]}>Theme</Text>
          <Text style={[styles.settingDesc, { color: colors.mutedForeground }]}>
            "System" follows your device's light/dark setting.
          </Text>
          <View style={styles.chipRow}>
            {THEME_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                onPress={() => theme.setPreference(opt.value)}
                style={[
                  styles.chip,
                  {
                    backgroundColor:
                      theme.preference === opt.value ? colors.primary : colors.secondary,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    {
                      color:
                        theme.preference === opt.value
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
              {biometricEnabled
                ? "Automatically lock when app is in background"
                : "Enable biometric unlock for auto-lock to take effect"}
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

          {/* Sign Out button */}
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.destructive, marginTop: 12 }]}
            onPress={handleSignOut}
          >
            <Text style={[styles.buttonText, { color: colors.destructiveForeground }]}>
              Sign Out
            </Text>
          </TouchableOpacity>
        </View>

        {/* Diagnostics — on-device view of the app log (no adb needed).
            Admin-only: hidden for regular accounts (incl. the public demo). */}
        {isAdmin && (
          <>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>DIAGNOSTICS</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.settingDesc, { color: colors.mutedForeground, marginBottom: 10 }]}>
            Recent app log (API calls, auth, errors). Useful for diagnosing
            connection or data issues.
          </Text>
          <View style={styles.diagBtnRow}>
            <TouchableOpacity
              style={[styles.diagBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
              onPress={toggleLogs}
            >
              <Text style={[styles.diagBtnText, { color: colors.foreground }]}>
                {showLogs ? "Hide log" : "Show recent log"}
              </Text>
            </TouchableOpacity>
            {showLogs && (
              <>
                <TouchableOpacity
                  style={[styles.diagBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                  onPress={refreshLogs}
                >
                  <Text style={[styles.diagBtnText, { color: colors.foreground }]}>Refresh</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.diagBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                  onPress={handleClearLogs}
                >
                  <Text style={[styles.diagBtnText, { color: colors.destructive }]}>Clear</Text>
                </TouchableOpacity>
              </>
            )}
          </View>

          {showLogs && (
            <View style={[styles.logBox, { backgroundColor: colors.background, borderColor: colors.border }]}>
              {logs.length === 0 ? (
                <Text style={[styles.logEmpty, { color: colors.mutedForeground }]}>
                  No log entries yet.
                </Text>
              ) : (
                logs.map((e, i) => (
                  <Text key={i} style={[styles.logLine, { color: logColor(e.level) }]}>
                    {logTime(e.ts)} {e.level.toUpperCase()} {e.tag}: {e.msg}
                  </Text>
                ))
              )}
            </View>
          )}
        </View>
          </>
        )}

        {/* About */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>ABOUT</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.aboutRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.aboutLabel, { color: colors.mutedForeground }]}>App</Text>
            <Text style={[styles.aboutValue, { color: colors.foreground }]}>Finlynq</Text>
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
  diagBtnRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  diagBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  diagBtnText: { fontSize: 13, fontWeight: "600" },
  logBox: {
    marginTop: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
  },
  logEmpty: { fontSize: 12 },
  logLine: { fontSize: 11, fontFamily: "monospace", marginBottom: 3, lineHeight: 15 },
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
