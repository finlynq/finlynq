import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import type { FeedbackType } from "../../../shared/types";

const TYPES: { value: FeedbackType; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
  { value: "question", label: "Question" },
  { value: "other", label: "Other" },
];

export default function FeedbackScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();

  const [type, setType] = useState<FeedbackType>("bug");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSend = async () => {
    if (!message.trim()) {
      Alert.alert("Error", "Please enter a message");
      return;
    }
    setSaving(true);
    try {
      const res = await endpoints.submitFeedback({ type, message: message.trim() });
      if (res.success) {
        logger.info("feedback", "submitted", { type });
        Alert.alert("Thanks!", "Your feedback has been sent.", [
          { text: "OK", onPress: () => navigation.goBack() },
        ]);
      } else {
        logger.warn("feedback", "submit rejected", { error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to send feedback");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("feedback", "submit threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.backBtn, { color: colors.primary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>Send Feedback</Text>
          <TouchableOpacity onPress={handleSend} disabled={saving}>
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.saveBtn, { color: colors.primary }]}>Send</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {/* Type */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>TYPE</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={fieldStyles.chipRow}>
                {TYPES.map((t) => {
                  const active = t.value === type;
                  return (
                    <TouchableOpacity
                      key={t.value}
                      onPress={() => setType(t.value)}
                      style={[
                        fieldStyles.chip,
                        {
                          backgroundColor: active ? colors.primary : colors.secondary,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          fieldStyles.chipText,
                          { color: active ? colors.primaryForeground : colors.foreground },
                        ]}
                      >
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>

            {/* Message */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>MESSAGE</Text>
              <TextInput
                style={[
                  fieldStyles.input,
                  {
                    color: colors.foreground,
                    backgroundColor: colors.secondary,
                    borderColor: colors.border,
                    minHeight: 120,
                    textAlignVertical: "top",
                  },
                ]}
                value={message}
                onChangeText={setMessage}
                placeholder="What happened, or what would you like to see?"
                placeholderTextColor={colors.mutedForeground}
                maxLength={4000}
                multiline
                autoFocus
              />
            </View>

            <Text style={[fieldStyles.hint, { color: colors.mutedForeground }]}>
              Please don&apos;t include sensitive financial details.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  saveBtn: { fontSize: 15, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 32 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 12,
  },
});

const fieldStyles = StyleSheet.create({
  container: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  input: {
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  chipRow: { flexDirection: "row" },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 8,
  },
  chipText: { fontSize: 13, fontWeight: "500" },
  hint: { fontSize: 12, lineHeight: 16 },
});
