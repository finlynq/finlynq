import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useTheme } from "../theme";

type ServerMode = "self-hosted" | "cloud";

interface Props {
  onSelect: (mode: ServerMode) => void;
}

export default function ModeSelectScreen({ onSelect }: Props) {
  const theme = useTheme();
  const colors = theme.colors;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.content}>
        {/* Logo */}
        <View style={[styles.logoBadge, { backgroundColor: colors.primary }]}>
          <Text style={styles.logoText}>PF</Text>
        </View>

        <Text style={[styles.title, { color: colors.foreground }]}>
          Welcome to PF
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Choose how you want to use the app
        </Text>

        {/* Self-hosted option */}
        <TouchableOpacity
          style={[styles.modeCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => onSelect("self-hosted")}
        >
          <View style={[styles.modeIcon, { backgroundColor: colors.secondary }]}>
            <Text style={styles.modeIconText}>🔒</Text>
          </View>
          <View style={styles.modeInfo}>
            <Text style={[styles.modeTitle, { color: colors.foreground }]}>
              Self-Hosted
            </Text>
            <Text style={[styles.modeDesc, { color: colors.mutedForeground }]}>
              Your data stays on your device. Secured with a passphrase. No account needed.
            </Text>
          </View>
        </TouchableOpacity>

        {/* Cloud option */}
        <TouchableOpacity
          style={[styles.modeCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => onSelect("cloud")}
        >
          <View style={[styles.modeIcon, { backgroundColor: colors.secondary }]}>
            <Text style={styles.modeIconText}>☁</Text>
          </View>
          <View style={styles.modeInfo}>
            <Text style={[styles.modeTitle, { color: colors.foreground }]}>
              Cloud
            </Text>
            <Text style={[styles.modeDesc, { color: colors.mutedForeground }]}>
              Sign in with your account. Access your data from any device. Synced and backed up.
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
  },
  content: {
    paddingHorizontal: 32,
    alignItems: "center",
  },
  logoBadge: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  logoText: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: 1,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    marginBottom: 28,
    textAlign: "center",
  },
  modeCard: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  modeIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  modeIconText: {
    fontSize: 22,
  },
  modeInfo: {
    flex: 1,
  },
  modeTitle: {
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 4,
  },
  modeDesc: {
    fontSize: 13,
    lineHeight: 18,
  },
});
