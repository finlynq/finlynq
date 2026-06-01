import React, { useEffect, useState } from "react";
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
import { safeName } from "../lib/format";
import {
  GOAL_TYPES,
  GOAL_PRIORITIES,
  COMMON_CURRENCIES,
  DEFAULT_CURRENCY,
} from "../lib/constants";
import type { Account } from "../../../shared/types";

export default function AddGoalScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [type, setType] = useState(GOAL_TYPES[0].value);
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState(GOAL_PRIORITIES[0].value);
  const [linkedAccountIds, setLinkedAccountIds] = useState<number[]>([]);
  const [note, setNote] = useState("");

  useEffect(() => {
    endpoints
      .getAccounts()
      .then((res) => {
        if (res.success) setAccounts(res.data);
        else logger.warn("add-goal", "accounts fetch failed", { error: res.error });
        setLoading(false);
      })
      .catch((e) => {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("add-goal", "accounts load threw", { detail });
        setLoading(false);
      });
  }, []);

  const toggleAccount = (id: number) => {
    setLinkedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSave = async () => {
    if (!name.trim()) {
      Alert.alert("Error", "Please enter a goal name");
      return;
    }
    const parsedTarget = parseFloat(targetAmount);
    if (isNaN(parsedTarget) || parsedTarget <= 0) {
      Alert.alert("Error", "Please enter a target amount greater than 0");
      return;
    }
    setSaving(true);
    try {
      const res = await endpoints.createGoal({
        name: name.trim(),
        type,
        targetAmount: parsedTarget,
        currency,
        deadline: deadline.trim() || undefined,
        accountIds: linkedAccountIds,
        priority,
        note: note.trim() || undefined,
      });
      if (res.success) {
        logger.info("add-goal", "goal created", { type, linked: linkedAccountIds.length });
        navigation.goBack();
      } else {
        logger.warn("add-goal", "create rejected", { error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to create goal");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("add-goal", "create threw", { detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  const renderChips = <T extends string | number>(
    options: { value: T; label: string }[] | readonly T[],
    selected: T,
    onSelect: (v: T) => void
  ) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={fieldStyles.chipRow}>
      {options.map((opt) => {
        const value = (typeof opt === "object" ? opt.value : opt) as T;
        const label = typeof opt === "object" ? opt.label : String(opt);
        const active = value === selected;
        return (
          <TouchableOpacity
            key={String(value)}
            onPress={() => onSelect(value)}
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
              numberOfLines={1}
            >
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

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
          <Text style={[styles.title, { color: colors.foreground }]}>Add Goal</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.saveBtn, { color: colors.primary }]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {/* Name */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>NAME</Text>
              <TextInput
                style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                value={name}
                onChangeText={setName}
                placeholder="e.g. Emergency Fund"
                placeholderTextColor={colors.mutedForeground}
                autoFocus
              />
            </View>

            {/* Target amount */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>TARGET AMOUNT</Text>
              <TextInput
                style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                value={targetAmount}
                onChangeText={setTargetAmount}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Type */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>TYPE</Text>
              {renderChips(GOAL_TYPES, type, setType)}
            </View>

            {/* Currency */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>CURRENCY</Text>
              {renderChips(COMMON_CURRENCIES, currency, setCurrency)}
            </View>

            {/* Priority */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>PRIORITY</Text>
              {renderChips(GOAL_PRIORITIES, priority, setPriority)}
            </View>

            {/* Deadline (optional) */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>DEADLINE (OPTIONAL)</Text>
              <TextInput
                style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                value={deadline}
                onChangeText={setDeadline}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Linked accounts (optional multi-select) */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>
                LINKED ACCOUNTS (OPTIONAL)
              </Text>
              {accounts.length === 0 ? (
                <Text style={[styles.noAccounts, { color: colors.mutedForeground }]}>
                  No accounts yet — the goal will be standalone.
                </Text>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={fieldStyles.chipRow}>
                  {accounts.map((acc) => {
                    const active = linkedAccountIds.includes(acc.id);
                    return (
                      <TouchableOpacity
                        key={acc.id}
                        onPress={() => toggleAccount(acc.id)}
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
                          numberOfLines={1}
                        >
                          {safeName(acc.name)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
            </View>

            {/* Note (optional) */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>NOTE (OPTIONAL)</Text>
              <TextInput
                style={[
                  fieldStyles.input,
                  { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border, minHeight: 60, textAlignVertical: "top" },
                ]}
                value={note}
                onChangeText={setNote}
                placeholder="Optional note"
                placeholderTextColor={colors.mutedForeground}
                multiline
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
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
  noAccounts: { fontSize: 13, paddingVertical: 4 },
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
});
