import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useTheme } from "../theme";
import { useAuth } from "../hooks/useAuth";

interface Props {
  isLoading: boolean;
}

export default function UnlockScreen({ isLoading: initialLoading }: Props) {
  const theme = useTheme();
  const { unlock, error, needsSetup, isLoading } = useAuth();
  const [passphrase, setPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);

  const handleUnlock = () => {
    if (passphrase.trim()) {
      unlock(passphrase);
    }
  };

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
          {needsSetup ? "Welcome to PF" : "Welcome Back"}
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {needsSetup
            ? "Set up your passphrase to get started"
            : "Enter your passphrase to unlock"}
        </Text>

        {/* Passphrase input */}
        <View style={styles.inputRow}>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: colors.secondary,
                color: colors.foreground,
                borderColor: error ? colors.destructive : colors.border,
              },
            ]}
            placeholder="Passphrase"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry={!showPass}
            value={passphrase}
            onChangeText={setPassphrase}
            onSubmitEditing={handleUnlock}
            autoFocus
            returnKeyType="go"
          />
          <TouchableOpacity
            style={styles.toggleBtn}
            onPress={() => setShowPass(!showPass)}
          >
            <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
              {showPass ? "Hide" : "Show"}
            </Text>
          </TouchableOpacity>
        </View>

        {error && (
          <Text style={[styles.error, { color: colors.destructive }]}>
            {error}
          </Text>
        )}

        <TouchableOpacity
          style={[
            styles.button,
            { backgroundColor: colors.primary, opacity: isLoading ? 0.7 : 1 },
          ]}
          onPress={handleUnlock}
          disabled={isLoading || !passphrase.trim()}
        >
          {isLoading ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
              {needsSetup ? "Set Up" : "Unlock"}
            </Text>
          )}
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
    marginBottom: 32,
    textAlign: "center",
  },
  inputRow: {
    width: "100%",
    position: "relative",
    marginBottom: 12,
  },
  input: {
    width: "100%",
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingRight: 60,
    fontSize: 16,
  },
  toggleBtn: {
    position: "absolute",
    right: 16,
    top: 14,
  },
  error: {
    fontSize: 13,
    marginBottom: 12,
    textAlign: "center",
  },
  button: {
    width: "100%",
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
