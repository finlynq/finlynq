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
  ScrollView,
} from "react-native";
import { useTheme } from "../theme";
import { getServerUrl } from "../api/client";
import type { RegisterPayload } from "../../../shared/types";

interface Props {
  onLogin: (identifier: string, password: string) => Promise<boolean>;
  onRegister: (payload: RegisterPayload) => Promise<boolean>;
  onServerUrlChange: (url: string) => void | Promise<void>;
  error: string | null;
  isLoading: boolean;
}

export default function LoginScreen({
  onLogin,
  onRegister,
  onServerUrlChange,
  error,
  isLoading,
}: Props) {
  const theme = useTheme();
  const colors = theme.colors;
  const [isRegisterMode, setIsRegisterMode] = useState(false);

  // Login uses a single identifier (username OR email); register splits them.
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [acknowledgeNoRecovery, setAcknowledgeNoRecovery] = useState(false);

  const [serverUrl, setServerUrl] = useState(getServerUrl());
  const [showServer, setShowServer] = useState(false);

  // When registering without an email there is no password-recovery path —
  // the backend requires an explicit acknowledgement.
  const needsAck = isRegisterMode && email.trim().length === 0;

  const canSubmit = isRegisterMode
    ? !!username.trim() && !!password && (!needsAck || acknowledgeNoRecovery)
    : !!identifier.trim() && !!password;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    // Apply + persist the server URL before authenticating so the request
    // hits the right backend (important on first run).
    await onServerUrlChange(serverUrl);
    if (isRegisterMode) {
      onRegister({
        username: username.trim(),
        email: email.trim() || undefined,
        password,
        displayName: displayName.trim() || undefined,
        acknowledgeNoRecovery: email.trim() ? undefined : true,
      });
    } else {
      onLogin(identifier.trim(), password);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.content}>
          {/* Logo */}
          <View style={[styles.logoBadge, { backgroundColor: colors.primary }]}>
            <Text style={[styles.logoText, { color: colors.primaryForeground }]}>
              F
            </Text>
          </View>

          <Text style={[styles.title, { color: colors.foreground }]}>
            {isRegisterMode ? "Create Account" : "Sign In"}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {isRegisterMode
              ? "Create your Finlynq account"
              : "Sign in to your Finlynq account"}
          </Text>

          {/* Display Name (register only) */}
          {isRegisterMode && (
            <View style={styles.inputRow}>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.secondary,
                    color: colors.foreground,
                    borderColor: colors.border,
                  },
                ]}
                placeholder="Display name (optional)"
                placeholderTextColor={colors.mutedForeground}
                value={displayName}
                onChangeText={setDisplayName}
                autoCapitalize="words"
                returnKeyType="next"
              />
            </View>
          )}

          {/* Username (register) */}
          {isRegisterMode && (
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
                placeholder="Username"
                placeholderTextColor={colors.mutedForeground}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>
          )}

          {/* Identifier (login) */}
          {!isRegisterMode && (
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
                placeholder="Username or email"
                placeholderTextColor={colors.mutedForeground}
                value={identifier}
                onChangeText={setIdentifier}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
            </View>
          )}

          {/* Email (register only, optional) */}
          {isRegisterMode && (
            <View style={styles.inputRow}>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.secondary,
                    color: colors.foreground,
                    borderColor: colors.border,
                  },
                ]}
                placeholder="Email (optional — for password reset)"
                placeholderTextColor={colors.mutedForeground}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                returnKeyType="next"
              />
            </View>
          )}

          {/* Password */}
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
              placeholder={
                isRegisterMode ? "Password (at least 12 characters)" : "Password"
              }
              placeholderTextColor={colors.mutedForeground}
              secureTextEntry={!showPass}
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={handleSubmit}
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

          {/* No-recovery acknowledgement (register without an email) */}
          {needsAck && (
            <TouchableOpacity
              style={[
                styles.ackRow,
                { borderColor: colors.border, backgroundColor: colors.secondary },
              ]}
              onPress={() => setAcknowledgeNoRecovery((v) => !v)}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.checkbox,
                  {
                    borderColor: acknowledgeNoRecovery
                      ? colors.primary
                      : colors.border,
                    backgroundColor: acknowledgeNoRecovery
                      ? colors.primary
                      : "transparent",
                  },
                ]}
              >
                {acknowledgeNoRecovery && (
                  <Text style={{ color: colors.primaryForeground, fontSize: 13 }}>
                    ✓
                  </Text>
                )}
              </View>
              <Text style={[styles.ackText, { color: colors.mutedForeground }]}>
                I understand: with no email there's no way to recover a forgotten
                password. Finlynq encrypts everything with my password.
              </Text>
            </TouchableOpacity>
          )}

          {error && (
            <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
          )}

          <TouchableOpacity
            style={[
              styles.button,
              {
                backgroundColor: colors.primary,
                opacity: isLoading || !canSubmit ? 0.6 : 1,
              },
            ]}
            onPress={handleSubmit}
            disabled={isLoading || !canSubmit}
          >
            {isLoading ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
                {isRegisterMode ? "Create Account" : "Sign In"}
              </Text>
            )}
          </TouchableOpacity>

          {/* Toggle login/register */}
          <TouchableOpacity
            style={styles.switchRow}
            onPress={() => setIsRegisterMode(!isRegisterMode)}
          >
            <Text style={[styles.switchText, { color: colors.mutedForeground }]}>
              {isRegisterMode
                ? "Already have an account? "
                : "Don't have an account? "}
            </Text>
            <Text style={[styles.switchLink, { color: colors.primary }]}>
              {isRegisterMode ? "Sign In" : "Create Account"}
            </Text>
          </TouchableOpacity>

          {/* Server URL — collapsed by default; needed by self-hosters. */}
          <TouchableOpacity
            style={styles.serverToggle}
            onPress={() => setShowServer((v) => !v)}
          >
            <Text style={[styles.serverToggleText, { color: colors.mutedForeground }]}>
              {showServer ? "Hide server settings" : `Server: ${serverUrl}`}
            </Text>
          </TouchableOpacity>

          {showServer && (
            <View style={styles.inputRow}>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.secondary,
                    color: colors.foreground,
                    borderColor: colors.border,
                    paddingRight: 16,
                  },
                ]}
                placeholder="https://finlynq.com"
                placeholderTextColor={colors.mutedForeground}
                value={serverUrl}
                onChangeText={setServerUrl}
                onEndEditing={() => onServerUrlChange(serverUrl)}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="done"
              />
            </View>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
  },
  content: {
    paddingHorizontal: 32,
    paddingVertical: 32,
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
    marginBottom: 24,
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
  ackRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 12,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  ackText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
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
  switchRow: {
    flexDirection: "row",
    marginTop: 20,
  },
  switchText: {
    fontSize: 14,
  },
  switchLink: {
    fontSize: 14,
    fontWeight: "600",
  },
  serverToggle: {
    marginTop: 24,
    marginBottom: 8,
  },
  serverToggleText: {
    fontSize: 13,
  },
});
