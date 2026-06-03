import React, { useMemo, useState } from "react";
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
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { ACCOUNT_TYPES, ACCOUNT_GROUPS, COMMON_CURRENCIES } from "../lib/constants";
import { accountFormFromRow } from "../lib/edit-prefill";
import type { AccountsStackParamList } from "../navigation/AccountsStack";

type AccountType = "A" | "L";

export default function AddAccountScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<{ goBack: () => void }>();
  const route = useRoute<RouteProp<AccountsStackParamList, "AddAccount">>();
  const editAccount = route.params?.account ?? null;
  const isEdit = !!editAccount;
  // Map the row (if editing) into the input string state once.
  const init = useMemo(() => accountFormFromRow(editAccount), [editAccount]);

  const [name, setName] = useState(init.name);
  const [type, setType] = useState<AccountType>(init.type);
  const [group, setGroup] = useState(init.group);
  const [currency, setCurrency] = useState(init.currency);
  const [alias, setAlias] = useState(init.alias);
  const [note, setNote] = useState(init.note);
  const [saving, setSaving] = useState(false);

  // Flipping type swaps the valid group list — reset group to the first option
  // of the new type so we never submit a group that belongs to the other type.
  const onSelectType = (t: AccountType) => {
    setType(t);
    setGroup(ACCOUNT_GROUPS[t][0]);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      Alert.alert("Error", "Please enter an account name");
      return;
    }
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        type,
        group,
        currency,
        alias: alias.trim() || undefined,
        note: note.trim() || undefined,
      };
      const res =
        isEdit && editAccount
          ? await endpoints.updateAccount({ id: editAccount.id, ...fields })
          : await endpoints.createAccount(fields);
      if (res.success) {
        logger.info("add-account", isEdit ? "account updated" : "account created", { type, group });
        navigation.goBack();
      } else {
        logger.warn("add-account", "save rejected", { error: res.error });
        Alert.alert("Error", "error" in res ? res.error : "Failed to save account");
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("add-account", "save threw", { detail });
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
          <Text style={[styles.title, { color: colors.foreground }]}>
            {isEdit ? "Edit Account" : "Add Account"}
          </Text>
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
                placeholder="e.g. Everyday Checking"
                placeholderTextColor={colors.mutedForeground}
                autoFocus={!isEdit}
              />
            </View>

            {/* Type */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>TYPE</Text>
              {renderChips(ACCOUNT_TYPES, type, onSelectType)}
            </View>

            {/* Group (dynamic per type) */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>GROUP</Text>
              {renderChips(ACCOUNT_GROUPS[type], group, setGroup)}
            </View>

            {/* Currency */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>CURRENCY</Text>
              {renderChips(COMMON_CURRENCIES, currency, setCurrency)}
            </View>

            {/* Alias (optional) */}
            <View style={fieldStyles.container}>
              <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>ALIAS (OPTIONAL)</Text>
              <TextInput
                style={[fieldStyles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
                value={alias}
                onChangeText={setAlias}
                placeholder="Short nickname"
                placeholderTextColor={colors.mutedForeground}
                maxLength={64}
              />
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

          {!isEdit && (
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Set the starting balance by adding a transaction once the account exists.
            </Text>
          )}
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
  hint: { fontSize: 12, textAlign: "center", paddingHorizontal: 24, lineHeight: 18 },
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
