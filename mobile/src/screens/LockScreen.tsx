import React, { useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useTheme } from "../theme";

interface Props {
  /** Attempt a biometric unlock (resolves true on success). */
  onBiometricUnlock: () => Promise<boolean>;
  /** Drop the session and return to the sign-in screen. */
  onSignOut: () => void;
}

/**
 * Lightweight biometric lock gate. Shown only when a validated session token
 * is held but the UI is locked behind Face ID / fingerprint (biometric enabled
 * + auto-lock fired). There is no passphrase here — the session token already
 * lives in SecureStore; biometrics only gate the local UI.
 */
export default function LockScreen({ onBiometricUnlock, onSignOut }: Props) {
  const theme = useTheme();
  const colors = theme.colors;

  // Auto-prompt on mount so the user lands straight on the biometric sheet.
  useEffect(() => {
    onBiometricUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.content}>
        {/* Logo */}
        <View style={[styles.logoBadge, { backgroundColor: colors.primary }]}>
          <Text style={[styles.logoText, { color: colors.primaryForeground }]}>
            F
          </Text>
        </View>

        <Text style={[styles.title, { color: colors.foreground }]}>
          Welcome back
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Unlock Finlynq to continue
        </Text>

        <TouchableOpacity
          style={[styles.biometricBtn, { backgroundColor: colors.primary }]}
          onPress={onBiometricUnlock}
        >
          <Text style={[styles.biometricIcon, { color: colors.primaryForeground }]}>
            ⊕
          </Text>
          <Text style={[styles.biometricText, { color: colors.primaryForeground }]}>
            Unlock with Biometrics
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.signOutBtn} onPress={onSignOut}>
          <Text style={[styles.signOutText, { color: colors.mutedForeground }]}>
            Sign out
          </Text>
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
    fontSize: 30,
    fontWeight: "800",
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
  biometricBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: 48,
    borderRadius: 10,
    gap: 8,
  },
  biometricIcon: { fontSize: 22 },
  biometricText: { fontSize: 15, fontWeight: "600" },
  signOutBtn: {
    marginTop: 20,
  },
  signOutText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
