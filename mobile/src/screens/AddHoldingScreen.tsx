// Create a new (non-cash) holding before a Buy when the symbol isn't yet in the
// account. On save it routes back to the OperationForm with the new holding
// pre-selected (merge:true updates the existing form instance's params).
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Switch,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { safeName } from "../lib/format";
import { Icon } from "../components/icon";
import { PickerSheet, type PickerOption } from "../components/picker-sheet";
import { investmentAccounts } from "../lib/portfolio/holdings";
import { COMMON_CURRENCIES } from "../lib/portfolio/operations";
import type { AccountBalance } from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "AddHolding">;

export default function AddHoldingScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [accountId, setAccountId] = useState<number | null>(route.params?.accountId ?? null);
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [isCrypto, setIsCrypto] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    endpoints
      .getAccountBalances()
      .then((res) => {
        if (res.success) {
          // A new holding can't be created in an ARCHIVED account — unless the
          // caller explicitly passed it (e.g. an edit of an existing operation
          // on that account), so the form still shows its own account.
          const inv = investmentAccounts(res.data).filter(
            (a) => !a.archived || a.accountId === route.params?.accountId,
          );
          setAccounts(inv);
          if (accountId == null && inv.length > 0) {
            setAccountId(inv[0].accountId);
            setCurrency((inv[0].currency || "USD").toUpperCase());
          }
        } else {
          logger.warn("add-holding", "accounts fetch failed", { error: res.error });
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accountOptions: PickerOption[] = accounts.map((a) => ({
    id: a.accountId,
    label: safeName(a.accountName),
    sublabel: a.currency,
  }));
  const accountLabel = accounts.find((a) => a.accountId === accountId)?.accountName ?? null;

  const handleSave = async () => {
    if (accountId == null) {
      Alert.alert("Error", "Pick an account");
      return;
    }
    if (!name.trim() && !symbol.trim()) {
      Alert.alert("Error", "Enter a symbol or name");
      return;
    }
    setSaving(true);
    try {
      const res = await endpoints.createPortfolioHolding({
        name: name.trim() || symbol.trim().toUpperCase(),
        accountId,
        symbol: symbol.trim() ? symbol.trim().toUpperCase() : undefined,
        currency: currency.toUpperCase(),
        isCrypto,
        note: note.trim() || undefined,
      });
      if (res.success && res.data?.id) {
        logger.info("add-holding", "created", { id: res.data.id });
        const op = route.params?.op;
        if (op) {
          navigation.navigate({
            name: "OperationForm",
            params: { op, preselectAccountId: accountId, preselectHoldingId: res.data.id },
            merge: true,
          });
        } else {
          navigation.goBack();
        }
      } else {
        Alert.alert("Error", "error" in res ? res.error : "Failed to create holding");
      }
    } catch (e) {
      logger.error("add-holding", "create threw", { detail: String(e) });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={[styles.cancel, { color: colors.primary }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.foreground }]}>New holding</Text>
          <TouchableOpacity onPress={handleSave} disabled={saving}>
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.save, { color: colors.primary }]}>Save</Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Field label="ACCOUNT">
              <TouchableOpacity
                onPress={() => setPickerOpen(true)}
                style={[styles.select, { backgroundColor: colors.secondary, borderColor: colors.border }]}
              >
                <Text style={[styles.selectText, { color: accountLabel ? colors.foreground : colors.mutedForeground }]} numberOfLines={1}>
                  {accountLabel ? safeName(accountLabel) : "Select account"}
                </Text>
                <Icon name="chevronDown" size={16} color={colors.mutedForeground} />
              </TouchableOpacity>
            </Field>

            <Field label="SYMBOL">
              <TextInput
                style={inputStyle(colors)}
                value={symbol}
                onChangeText={setSymbol}
                placeholder="NVDA"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="characters"
                autoCorrect={false}
              />
            </Field>

            <Field label="NAME">
              <TextInput
                style={inputStyle(colors)}
                value={name}
                onChangeText={setName}
                placeholder="Nvidia Corp"
                placeholderTextColor={colors.mutedForeground}
              />
            </Field>

            <Field label="CURRENCY">
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {COMMON_CURRENCIES.map((c) => {
                  const active = currency === c;
                  return (
                    <TouchableOpacity
                      key={c}
                      onPress={() => setCurrency(c)}
                      style={[
                        styles.chip,
                        { backgroundColor: active ? colors.primary : colors.secondary, borderColor: active ? colors.primary : colors.border },
                      ]}
                    >
                      <Text style={{ color: active ? colors.primaryForeground : colors.foreground, fontSize: 13, fontWeight: "600" }}>
                        {c}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </Field>

            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { color: colors.foreground }]}>Crypto asset?</Text>
              <Switch
                value={isCrypto}
                onValueChange={setIsCrypto}
                trackColor={{ true: colors.primary, false: colors.border }}
              />
            </View>

            <Field label="NOTE (OPTIONAL)">
              <TextInput
                style={[inputStyle(colors), { minHeight: 56, textAlignVertical: "top" }]}
                value={note}
                onChangeText={setNote}
                placeholder="—"
                placeholderTextColor={colors.mutedForeground}
                multiline
              />
            </Field>
          </View>
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            Creates the holding, then returns to the operation with it pre-selected.
          </Text>
        </ScrollView>

        <PickerSheet
          visible={pickerOpen}
          title="Select account"
          options={accountOptions}
          selectedId={accountId}
          onSelect={(id) => {
            setAccountId(id);
            const a = accounts.find((x) => x.accountId === id);
            if (a) setCurrency((a.currency || "USD").toUpperCase());
          }}
          onClose={() => setPickerOpen(false)}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
      {children}
    </View>
  );
}

function inputStyle(colors: ReturnType<typeof useTheme>["colors"]) {
  return {
    fontSize: 15,
    color: colors.foreground,
    backgroundColor: colors.secondary,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  };
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
  cancel: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  save: { fontSize: 15, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 32 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
  field: { marginBottom: 16 },
  fieldLabel: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  select: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectText: { fontSize: 15, flex: 1, marginRight: 8 },
  chipRow: { gap: 8, paddingVertical: 2 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  toggleLabel: { fontSize: 14, fontWeight: "600" },
  hint: { fontSize: 12, marginTop: 12 },
});
