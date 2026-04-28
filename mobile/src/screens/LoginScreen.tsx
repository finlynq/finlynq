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

interface Props {
  onLogin: (email: string, password: string) => Promise<boolean>;
  onRegister: (email: string, password: string, displayName?: string) => Promise<boolean>;
  onBack: () => void;
  error: string | null;
  isLoading: boolean;
}

export default function LoginScreen({ onLogin, onRegister, onBack, error, isLoading }: Props) {
  const theme = useTheme();
  const colors = theme.colors;
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPass, setShowPass] = useState(false);

  const handleSubmit = () => {
    if (!email.trim() || !password.trim()) return;
    if (isRegisterMode) {
      onRegister(email.trim(), password, displayName.trim() || undefined);
    } else {
      onLogin(email.trim(), password);
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
          {/* Back button */}
          <TouchableOpacity style={styles.backBtn} onPress={onBack}>
            <Text style={[styles.backText, { color: colors.primary }]}>← Back</Text>
          </TouchableOpacity>

          {/* Logo */}
          <View style={[styles.logoBadge, { backgroundColor: colors.primary }]}>
            <Text style={styles.logoText}>PF</Text>
          </View>

          <Text style={[styles.title, { color: colors.foreground }]}>
            {isRegisterMode ? "Create Account" : "Sign In"}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {isRegisterMode
              ? "Create your PF Cloud account"
              : "Sign in to your PF Cloud account"}
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
                placeholder="Display Name (optional)"
                placeholderTextColor={colors.mutedForeground}
                value={displayName}
                onChangeText={setDisplayName}
                autoCapitalize="words"
                returnKeyType="next"
              />
            </View>
          )}

          {/* Email */}
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
              placeholder="Email"
              placeholderTextColor={colors.mutedForeground}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              returnKeyType="next"
            />
          </View>

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
              placeholder={isRegisterMode ? "Password (8+ characters)" : "Password"}
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

          {error && (
            <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
          )}

          <TouchableOpacity
            style={[
              styles.button,
              { backgroundColor: colors.primary, opacity: isLoading ? 0.7 : 1 },
            ]}
            onPress={handleSubmit}
            disabled={isLoading || !email.trim() || !password.trim()}
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
              {isRegisterMode ? "Already have an account? " : "Don't have an account? "}
            </Text>
            <Text style={[styles.switchLink, { color: colors.primary }]}>
              {isRegisterMode ? "Sign In" : "Create Account"}
            </Text>
          </TouchableOpacity>
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
    alignItems: "center",
  },
  backBtn: {
    alignSelf: "flex-start",
    marginBottom: 24,
  },
  backText: {
    fontSize: 15,
    fontWeight: "600",
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
});
