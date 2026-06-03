import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  Switch,
  Linking,
  Modal,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Constants from "expo-constants";
import { useTheme, type ThemePreference } from "../theme";
import { useAuth } from "../hooks/useAuth";
import { getServerUrl, endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { getLogs, clearLogs, type LogEntry, type LogLevel } from "../lib/logger";
import { PickerSheet, type PickerOption } from "../components/picker-sheet";
import { DISPLAY_CURRENCIES } from "../lib/constants";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Nav = NativeStackNavigationProp<MoreStackParamList, "Settings">;

// The PickerSheet keys on a numeric `id`, so each currency's id is its index in
// DISPLAY_CURRENCIES; onSelect maps the index back to the 3-letter code.
const CURRENCY_OPTIONS: PickerOption[] = DISPLAY_CURRENCIES.map((c, i) => ({
  id: i,
  label: `${c.code} — ${c.label}`,
}));

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
  const navigation = useNavigation<Nav>();
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

  // 4a — display currency. `null` while loading; the row shows a dash until the
  // GET resolves. Picking a code PUTs it and flips `currencySaved` briefly.
  const [displayCurrency, setDisplayCurrency] = useState<string | null>(null);
  const [currencyPickerOpen, setCurrencyPickerOpen] = useState(false);
  const [currencySaved, setCurrencySaved] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await endpoints.getDisplayCurrency();
      if (res.success) setDisplayCurrency(res.data?.displayCurrency ?? "CAD");
      else logger.warn("settings", "display-currency fetch failed", { error: res.error });
    })();
  }, []);

  const onPickCurrency = async (id: number) => {
    const code = DISPLAY_CURRENCIES[id]?.code;
    if (!code || code === displayCurrency) return;
    const prev = displayCurrency;
    setDisplayCurrency(code); // optimistic
    setCurrencySaved(false);
    const res = await endpoints.setDisplayCurrency(code);
    if (res.success) {
      setDisplayCurrency(res.data?.displayCurrency ?? code);
      setCurrencySaved(true);
      setTimeout(() => setCurrencySaved(false), 2000);
      logger.info("settings", "display currency changed", { code });
    } else {
      setDisplayCurrency(prev); // revert
      logger.warn("settings", "display-currency save failed", { error: res.error });
      Alert.alert("Couldn't change currency", res.error || "Please try again.");
    }
  };

  // Destructive-data flow: which confirm is open ("wipe" = keep login, "delete"
  // = remove account), the typed password, and an in-flight guard.
  const [dataAction, setDataAction] = useState<null | "wipe" | "delete">(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

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

  const closeDataModal = () => {
    setDataAction(null);
    setPassword("");
  };

  const runDataAction = async () => {
    if (!password) {
      Alert.alert("Password required", "Enter your password to continue.");
      return;
    }
    const isDelete = dataAction === "delete";
    setBusy(true);
    try {
      const res = isDelete
        ? await endpoints.deleteAccount(password)
        : await endpoints.wipeData(password);
      if (res.success) {
        logger.info("settings", isDelete ? "account deleted" : "data wiped");
        closeDataModal();
        // The server evicts the session DEK (and drops the user on delete), so
        // the only valid next state is signed-out.
        Alert.alert(
          isDelete ? "Account deleted" : "Data deleted",
          isDelete
            ? "Your account and all data have been permanently deleted."
            : "All your data has been permanently deleted.",
          [{ text: "OK", onPress: signOut }]
        );
      } else {
        logger.warn("settings", "data action rejected", { error: res.error });
        Alert.alert("Couldn't complete", res.error || "Please try again.");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("settings", "data action threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setBusy(false);
    }
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
            placeholder="https://finlynq.com"
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

        {/* General — display currency. Converted screens (Dashboard / Accounts /
            Portfolio / Reports) refetch on focus, so the change is reflected on
            return without an explicit broadcast. */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>GENERAL</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TouchableOpacity
            style={styles.navRow}
            onPress={() => setCurrencyPickerOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.settingLeft}>
              <Text style={[styles.settingLabel, { color: colors.foreground }]}>
                Display currency
              </Text>
              <Text style={[styles.settingDesc, { color: colors.mutedForeground }]}>
                {currencySaved
                  ? "✓ Saved"
                  : "Totals are converted into this currency for display."}
              </Text>
            </View>
            <Text style={[styles.navValue, { color: colors.mutedForeground }]}>
              {displayCurrency ?? "—"} ›
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

        {/* Reconciliation — link to the fuzzy-match threshold editor. */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>RECONCILIATION</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TouchableOpacity
            style={styles.navRow}
            onPress={() => navigation.navigate("ReconcileThresholds")}
            activeOpacity={0.7}
          >
            <View style={styles.settingLeft}>
              <Text style={[styles.settingLabel, { color: colors.foreground }]}>
                Match thresholds
              </Text>
              <Text style={[styles.settingDesc, { color: colors.mutedForeground }]}>
                Tune how the reconcile screen suggests matches.
              </Text>
            </View>
            <Text style={[styles.navValue, { color: colors.mutedForeground }]}>›</Text>
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

        {/* Data — destructive. Mirrors web Settings → Data (password-gated). */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>DATA</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.settingDesc, { color: colors.mutedForeground, marginBottom: 12 }]}>
            Deleting is permanent and cannot be undone.
          </Text>
          <TouchableOpacity
            style={[styles.dangerOutlineBtn, { borderColor: colors.destructive }]}
            onPress={() => {
              setPassword("");
              setDataAction("wipe");
            }}
          >
            <Text style={[styles.dangerOutlineText, { color: colors.destructive }]}>
              Delete all data
            </Text>
          </TouchableOpacity>
          <Text style={[styles.settingDesc, { color: colors.mutedForeground, marginTop: 6 }]}>
            Removes every record but keeps your login.
          </Text>
          <TouchableOpacity
            style={[styles.button, { backgroundColor: colors.destructive, marginTop: 14 }]}
            onPress={() => {
              setPassword("");
              setDataAction("delete");
            }}
          >
            <Text style={[styles.buttonText, { color: colors.destructiveForeground }]}>
              Delete account
            </Text>
          </TouchableOpacity>
          <Text style={[styles.settingDesc, { color: colors.mutedForeground, marginTop: 6 }]}>
            Deletes your account and all data.
          </Text>
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
            <Text style={[styles.aboutValue, { color: colors.foreground }]}>
              {Constants.expoConfig?.version ?? "—"}
            </Text>
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

        {/* Legal — required for the Play listing + Data Safety form. */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>LEGAL</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TouchableOpacity
            style={[styles.aboutRow, { borderBottomColor: colors.border }]}
            onPress={() => Linking.openURL("https://finlynq.com/privacy")}
          >
            <Text style={[styles.aboutLabel, { color: colors.foreground }]}>Privacy Policy</Text>
            <Text style={[styles.aboutValue, { color: colors.primary }]}>↗</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.aboutRow}
            onPress={() => Linking.openURL("https://finlynq.com/terms")}
          >
            <Text style={[styles.aboutLabel, { color: colors.foreground }]}>Terms of Service</Text>
            <Text style={[styles.aboutValue, { color: colors.primary }]}>↗</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            Privacy-first personal finance
          </Text>
        </View>
      </ScrollView>

      {/* Password-gated confirmation for delete-data / delete-account. */}
      <Modal
        visible={dataAction !== null}
        transparent
        animationType="fade"
        onRequestClose={closeDataModal}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              {dataAction === "delete" ? "Delete account?" : "Delete all data?"}
            </Text>
            <Text style={[styles.modalDesc, { color: colors.mutedForeground }]}>
              {dataAction === "delete"
                ? "This permanently deletes your account and every record. This cannot be undone."
                : "This permanently deletes all your data but keeps your login. This cannot be undone."}
            </Text>
            <TextInput
              style={[
                styles.input,
                { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border, marginTop: 4 },
              ]}
              value={password}
              onChangeText={setPassword}
              placeholder="Enter your password"
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={[styles.modalNote, { color: colors.mutedForeground }]}>
              If you have two-factor enabled, delete from the web app instead.
            </Text>
            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.secondary }]}
                onPress={closeDataModal}
                disabled={busy}
              >
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.destructive }]}
                onPress={runDataAction}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.destructiveForeground} />
                ) : (
                  <Text style={[styles.modalBtnText, { color: colors.destructiveForeground }]}>
                    {dataAction === "delete" ? "Delete account" : "Delete data"}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Display-currency picker (4a). */}
      <PickerSheet
        visible={currencyPickerOpen}
        title="Display currency"
        options={CURRENCY_OPTIONS}
        selectedId={
          displayCurrency
            ? DISPLAY_CURRENCIES.findIndex((c) => c.code === displayCurrency)
            : null
        }
        onSelect={onPickCurrency}
        onClose={() => setCurrencyPickerOpen(false)}
      />
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
  dangerOutlineBtn: {
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dangerOutlineText: { fontSize: 15, fontWeight: "600" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 8 },
  modalDesc: { fontSize: 14, lineHeight: 20, marginBottom: 12 },
  modalNote: { fontSize: 12, marginTop: 8, marginBottom: 4 },
  modalBtnRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  modalBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnText: { fontSize: 15, fontWeight: "700" },
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
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  navValue: { fontSize: 15, fontWeight: "600" },
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
