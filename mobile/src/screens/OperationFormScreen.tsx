// The single generic renderer for all 8 portfolio operations. Interprets the
// config from lib/portfolio/operations.ts: parallel-loads accounts/holdings
// (+categories when referenced), runs the edit-prefill path, renders fields
// via PickerSheet + amount-card styling, and centralizes the cash-sleeve gate
// + the structured-error switch (cash_sleeve_not_found / portfolio_edit_blocked).
import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { safeName } from "../lib/format";
import { Icon } from "../components/icon";
import { PickerSheet, type PickerOption } from "../components/picker-sheet";
import { CashSleeveBanner } from "../components/portfolio/CashSleeveBanner";
import { BlockingClosuresNotice } from "../components/portfolio/BlockingClosuresNotice";
import { LotPickerSheet, type LotPick } from "../components/portfolio/LotPickerSheet";
import {
  getOpConfig,
  initialOpState,
  COMMON_CURRENCIES,
  type OpState,
  type OpContext,
  type FieldSpec,
} from "../lib/portfolio/operations";
import {
  investmentAccounts,
  nonInvestmentAccounts,
  accountHoldings,
  sleeveCurrencies,
} from "../lib/portfolio/holdings";
import type {
  AccountBalance,
  PortfolioHoldingRow,
  Category,
  LotRow,
} from "../../../shared/types";
import type { PortfolioStackParamList } from "../navigation/PortfolioStack";

type Props = NativeStackScreenProps<PortfolioStackParamList, "OperationForm">;

type AccountKey = "accountId" | "sourceAccountId" | "destAccountId";

export default function OperationFormScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const isFocused = useIsFocused();
  const { op, editId, preselectAccountId, preselectHoldingId } = route.params;
  const config = getOpConfig(op);
  const usesCategory = config.fields.some((f) => f.kind === "category");

  const [form, setForm] = useState<OpState>(() => initialOpState());
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [holdings, setHoldings] = useState<PortfolioHoldingRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creatingSleeve, setCreatingSleeve] = useState(false);
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const [lotSheetOpen, setLotSheetOpen] = useState(false);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [serverSleeve, setServerSleeve] = useState<{ accountId: number; currency: string } | null>(null);
  const [blockingTxIds, setBlockingTxIds] = useState<number[]>([]);

  const set = useCallback((patch: Partial<OpState>) => setForm((p) => ({ ...p, ...patch })), []);

  // --- initial load (accounts + holdings + categories + edit prefill) ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [accRes, holdRes, catRes] = await Promise.all([
          endpoints.getAccountBalances(),
          endpoints.getPortfolioHoldings(),
          usesCategory ? endpoints.getCategories() : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (accRes.success) setAccounts(accRes.data);
        if (holdRes.success) setHoldings(holdRes.data);
        if (catRes && catRes.success) setCategories(catRes.data);

        // Edit prefill via the load endpoint (guards data.op === key).
        if (editId != null) {
          const loadRes = await endpoints.loadPortfolioOperation(editId);
          if (!cancelled && loadRes.success && loadRes.data) {
            set({ ...config.prefillFromLoad(loadRes.data) });
          }
        }
        // Preselect (from chooser / holding detail / AddHolding return).
        if (!cancelled) {
          const patch: Partial<OpState> = {};
          if (preselectAccountId != null) {
            patch.accountId = preselectAccountId;
            patch.sourceAccountId = preselectAccountId;
          }
          if (preselectHoldingId != null) {
            patch.holdingId = preselectHoldingId;
            patch.sourceHoldingId = preselectHoldingId;
          }
          if (Object.keys(patch).length) set(patch);
        }
      } catch (e) {
        logger.error("op-form", "load threw", { detail: String(e) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch holdings when the screen regains focus (a freshly created holding /
  // cash sleeve from a pushed modal should appear) + honor a returned preselect.
  useEffect(() => {
    if (!isFocused || loading) return;
    endpoints.getPortfolioHoldings().then((res) => {
      if (res.success) setHoldings(res.data);
    });
    if (preselectHoldingId != null) {
      set({ holdingId: preselectHoldingId });
      setServerSleeve(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, preselectHoldingId]);

  const ctx: OpContext = useMemo(
    () => ({ accounts, holdings, categories }),
    [accounts, holdings, categories]
  );

  const clientSleeve = config.needsCashSleeve?.(form, ctx) ?? null;
  const sleeveReq = serverSleeve ?? clientSleeve;
  const saveDisabled = saving || clientSleeve != null;

  // --- cash sleeve creation (409-dup treated as success) ---
  const createSleeve = async () => {
    if (!sleeveReq) return;
    setCreatingSleeve(true);
    try {
      const res = await endpoints.createCashSleeve({
        accountId: sleeveReq.accountId,
        currency: sleeveReq.currency,
      });
      const ok = res.ok || res.error?.code === "duplicate_cash_sleeve";
      if (ok) {
        const holdRes = await endpoints.getPortfolioHoldings();
        if (holdRes.success) setHoldings(holdRes.data);
        setServerSleeve(null);
      } else {
        Alert.alert("Error", res.error?.error ?? "Failed to create cash sleeve");
      }
    } catch (e) {
      logger.error("op-form", "create sleeve threw", { detail: String(e) });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setCreatingSleeve(false);
    }
  };

  // --- submit ---
  const submit = async () => {
    const err = config.validate(form, ctx);
    if (err) {
      Alert.alert("Check the form", err);
      return;
    }
    setBlockingTxIds([]);
    setSaving(true);
    try {
      const body = { ...config.toBody(form, ctx), editId: editId ?? undefined };
      const res = await endpoints.postPortfolioOperation(op, body);
      if (res.ok) {
        logger.info("op-form", "saved", { op, edit: editId != null });
        navigation.goBack();
        return;
      }
      const e = res.error;
      if (e?.code === "cash_sleeve_not_found" && e.currency && e.accountId != null) {
        setServerSleeve({ accountId: e.accountId, currency: e.currency });
      } else if (e?.code === "portfolio_edit_blocked" && e.blockingClosureTxIds?.length) {
        setBlockingTxIds(e.blockingClosureTxIds);
      } else {
        Alert.alert("Error", e?.error ?? "Failed to save");
      }
    } catch (e) {
      logger.error("op-form", "submit threw", { detail: String(e) });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setSaving(false);
    }
  };

  // --- lot picker ---
  const openLotPicker = async () => {
    if (form.holdingId == null) {
      Alert.alert("Pick a holding first", "Choose the holding to sell before selecting lots.");
      return;
    }
    const res = await endpoints.getPortfolioLots(form.holdingId, form.accountId ?? undefined);
    if (res.success && res.data) setLots(res.data.lots);
    setLotSheetOpen(true);
  };
  const onLotChange = (sel: LotPick[]) => {
    const sum = sel.reduce((s, l) => s + l.qty, 0);
    set({ lotSelection: sel, qty: sum > 0 ? String(sum) : form.qty });
  };

  const goToTransactions = () => {
    const parent = navigation.getParent();
    parent?.navigate("Transactions" as never);
  };

  // --- account-change resets dependent holding/currency fields ---
  const onAccountChange = (key: AccountKey, id: number) => {
    const patch: Partial<OpState> = { [key]: id } as Partial<OpState>;
    for (const f of config.fields) {
      if ((f.kind === "holding" || f.kind === "sleeveCurrency") && f.accountKey === key) {
        if (f.kind === "holding") patch[f.key] = null;
        else patch[f.key] = "";
      }
      if (f.kind === "relatedHolding" && f.accountKey === key) patch.relatedHoldingId = null;
    }
    setServerSleeve(null);
    set(patch);
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
          <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
            {editId != null ? `Edit ${config.title}` : config.title}
          </Text>
          <TouchableOpacity onPress={submit} disabled={saveDisabled}>
            {saving ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={[styles.save, { color: saveDisabled ? colors.mutedForeground : colors.primary }]}>
                Save
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {blockingTxIds.length > 0 && (
            <BlockingClosuresNotice txIds={blockingTxIds} onPressTx={goToTransactions} />
          )}

          {config.fields.map((f, i) => (
            <FieldRenderer
              key={`${f.kind}-${i}`}
              field={f}
              form={form}
              ctx={ctx}
              config={config}
              colors={colors}
              set={set}
              onAccountChange={onAccountChange}
              setOpenPicker={setOpenPicker}
              openLotPicker={openLotPicker}
            />
          ))}

          {sleeveReq && (
            <CashSleeveBanner currency={sleeveReq.currency} creating={creatingSleeve} onCreate={createSleeve} />
          )}
        </ScrollView>

        {/* Pickers — keyed by the field's state key so multiple selects coexist. */}
        <AccountPickers
          config={config}
          form={form}
          ctx={ctx}
          openPicker={openPicker}
          onClose={() => setOpenPicker(null)}
          onAccountChange={onAccountChange}
          set={set}
          categories={categories}
        />

        <LotPickerSheet
          visible={lotSheetOpen}
          lots={lots}
          selection={form.lotSelection}
          currency={form.currency || "USD"}
          onChange={onLotChange}
          onClose={() => setLotSheetOpen(false)}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// --- field renderer -----------------------------------------------------

type ThemeColors = ReturnType<typeof useTheme>["colors"];

function FieldRenderer({
  field,
  form,
  ctx,
  config,
  colors,
  set,
  onAccountChange,
  setOpenPicker,
  openLotPicker,
}: {
  field: FieldSpec;
  form: OpState;
  ctx: OpContext;
  config: ReturnType<typeof getOpConfig>;
  colors: ThemeColors;
  set: (p: Partial<OpState>) => void;
  onAccountChange: (key: AccountKey, id: number) => void;
  setOpenPicker: (k: string | null) => void;
  openLotPicker: () => void;
}) {
  const f = field;

  switch (f.kind) {
    case "amount":
      return (
        <View style={[styles.amountCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.amountLabel, { color: colors.mutedForeground }]}>
            {config.amountLabel ? config.amountLabel(form, ctx) : f.label}
          </Text>
          <View style={styles.amountInputRow}>
            <Text style={[styles.amountPrefix, { color: colors.mutedForeground }]}>$</Text>
            <TextInput
              style={[styles.amountInput, { color: colors.foreground }]}
              value={form.amount}
              onChangeText={(t) => set({ amount: t })}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
        </View>
      );

    case "account": {
      const label = accountLabelFor(ctx, form[f.key]);
      return (
        <FieldCard label={f.label} colors={colors}>
          <SelectField
            value={label}
            placeholder="Select account"
            colors={colors}
            onPress={() => setOpenPicker(f.key)}
          />
        </FieldCard>
      );
    }

    case "holding": {
      const h = ctx.holdings.find((x) => x.id === form[f.key]);
      const accId = form[f.accountKey];
      const shares = h ? `${h.currentShares} shares · ${h.currency}` : undefined;
      return (
        <FieldCard label={f.label} colors={colors}>
          <SelectField
            value={h ? safeName(h.symbol || h.name) : null}
            placeholder={accId == null ? "Pick an account first" : "Select holding"}
            sub={shares}
            colors={colors}
            onPress={() => accId != null && setOpenPicker(f.key)}
          />
        </FieldCard>
      );
    }

    case "relatedHolding": {
      const h = ctx.holdings.find((x) => x.id === form.relatedHoldingId);
      return (
        <FieldCard label={f.label} colors={colors}>
          <SelectField
            value={h ? safeName(h.symbol || h.name) : null}
            placeholder="None"
            colors={colors}
            onPress={() => setOpenPicker("relatedHoldingId")}
          />
        </FieldCard>
      );
    }

    case "category": {
      // The category field is only consumed for the "Other" entry type — a
      // preset (dividend/interest/fee) auto-resolves its category server-side.
      if (form.incomeType !== "other") return null;
      const c = ctx.categories.find((x) => x.id === form.categoryId);
      return (
        <FieldCard label={f.label} colors={colors}>
          <SelectField
            value={c ? safeName(c.name) : null}
            placeholder="None"
            colors={colors}
            onPress={() => setOpenPicker("categoryId")}
          />
        </FieldCard>
      );
    }

    case "sleeveCurrency": {
      const sleeves = sleeveCurrencies(ctx.holdings, form[f.accountKey]);
      const opts = sleeves.length ? sleeves : COMMON_CURRENCIES;
      const current = form[f.key];
      return (
        <FieldCard label={f.label} colors={colors}>
          <CurrencyChips options={opts} value={current} colors={colors} onSelect={(c) => set({ [f.key]: c } as Partial<OpState>)} />
        </FieldCard>
      );
    }

    case "currency":
      return (
        <FieldCard label={f.label} colors={colors}>
          <CurrencyChips
            options={COMMON_CURRENCIES}
            value={form[f.key]}
            colors={colors}
            onSelect={(c) => set({ [f.key]: c } as Partial<OpState>)}
          />
        </FieldCard>
      );

    case "number":
      return (
        <FieldCard label={f.label} colors={colors}>
          <TextInput
            style={inputStyle(colors)}
            value={form[f.key]}
            onChangeText={(t) => set({ [f.key]: t } as Partial<OpState>)}
            keyboardType="decimal-pad"
            placeholder={f.placeholder ?? "0"}
            placeholderTextColor={colors.mutedForeground}
          />
        </FieldCard>
      );

    case "signToggle":
      return (
        <FieldCard label={f.label} colors={colors}>
          <View style={[styles.seg, { backgroundColor: colors.secondary }]}>
            {[
              { v: false, label: "Income", bg: colors.pos },
              { v: true, label: "Expense", bg: colors.neg },
            ].map((opt) => {
              const active = form.isExpense === opt.v;
              return (
                <TouchableOpacity
                  key={opt.label}
                  style={[styles.segBtn, active && { backgroundColor: opt.bg }]}
                  onPress={() =>
                    set({
                      isExpense: opt.v,
                      // Keep the entry-type preset consistent with the sign.
                      incomeType: opt.v ? "fee" : "dividend",
                    })
                  }
                >
                  <Text style={{ color: active ? "#fff" : colors.mutedForeground, fontWeight: "600", fontSize: 14 }}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </FieldCard>
      );

    case "incomeType": {
      const opts: Array<{ v: OpState["incomeType"]; label: string }> = form.isExpense
        ? [
            { v: "fee", label: "Fee" },
            { v: "other", label: "Other" },
          ]
        : [
            { v: "dividend", label: "Dividend" },
            { v: "interest", label: "Interest" },
            { v: "other", label: "Other" },
          ];
      const presetName =
        form.incomeType === "dividend"
          ? "Dividends"
          : form.incomeType === "interest"
            ? "Interest"
            : form.incomeType === "fee"
              ? "Investment Fees"
              : null;
      return (
        <FieldCard label={f.label} colors={colors}>
          <View style={[styles.seg, { backgroundColor: colors.secondary }]}>
            {opts.map((opt) => {
              const active = form.incomeType === opt.v;
              return (
                <TouchableOpacity
                  key={opt.v}
                  style={[styles.segBtn, active && { backgroundColor: colors.primary }]}
                  onPress={() => set({ incomeType: opt.v })}
                >
                  <Text style={{ color: active ? "#fff" : colors.mutedForeground, fontWeight: "600", fontSize: 14 }}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {presetName && (
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 6 }}>
              Auto-categorized as {presetName} (created if needed). Pick “Other” to choose a category manually.
            </Text>
          )}
        </FieldCard>
      );
    }

    case "lotPicker":
      return (
        <FieldCard label="Lots" colors={colors}>
          <View style={styles.lotToggleRow}>
            <Text style={[styles.lotToggleLabel, { color: colors.foreground }]}>Pick specific lots</Text>
            <TouchableOpacity
              onPress={() => {
                const next = !form.useLots;
                set({ useLots: next, lotSelection: next ? form.lotSelection : [] });
                if (next) openLotPicker();
              }}
              style={[
                styles.switch,
                { backgroundColor: form.useLots ? colors.primary : colors.border },
              ]}
            >
              <View style={[styles.switchKnob, form.useLots && styles.switchKnobOn]} />
            </TouchableOpacity>
          </View>
          {form.useLots && (
            <TouchableOpacity
              style={[styles.lotBtn, { borderColor: colors.border }]}
              onPress={openLotPicker}
            >
              <Text style={[styles.lotBtnText, { color: colors.primary }]}>
                {form.lotSelection.length > 0
                  ? `${form.lotSelection.length} lot(s) · ${form.lotSelection.reduce((s, l) => s + l.qty, 0)} units`
                  : "Select lots"}
              </Text>
            </TouchableOpacity>
          )}
          {!form.useLots && (
            <Text style={[styles.lotHint, { color: colors.mutedForeground }]}>
              Off → FIFO depletion. Selling beyond long inventory opens a short.
            </Text>
          )}
        </FieldCard>
      );

    case "date":
      return (
        <FieldCard label={f.label} colors={colors}>
          <TextInput
            style={inputStyle(colors)}
            value={form.date}
            onChangeText={(t) => set({ date: t })}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.mutedForeground}
            autoCorrect={false}
          />
        </FieldCard>
      );

    case "text":
      return (
        <FieldCard label={f.label} colors={colors}>
          <TextInput
            style={[inputStyle(colors), f.multiline ? { minHeight: 56, textAlignVertical: "top" } : null]}
            value={form[f.key]}
            onChangeText={(t) => set({ [f.key]: t } as Partial<OpState>)}
            placeholder={f.placeholder ?? ""}
            placeholderTextColor={colors.mutedForeground}
            multiline={f.multiline}
          />
        </FieldCard>
      );
  }
}

// --- account/holding/category PickerSheets (one open at a time) ----------

function AccountPickers({
  config,
  form,
  ctx,
  openPicker,
  onClose,
  onAccountChange,
  set,
  categories,
}: {
  config: ReturnType<typeof getOpConfig>;
  form: OpState;
  ctx: OpContext;
  openPicker: string | null;
  onClose: () => void;
  onAccountChange: (key: AccountKey, id: number) => void;
  set: (p: Partial<OpState>) => void;
  categories: Category[];
}) {
  const invOpts = toAccountOptions(investmentAccounts(ctx.accounts));
  const bankOpts = toAccountOptions(nonInvestmentAccounts(ctx.accounts));

  // Render each account/holding/related/category field's PickerSheet; only the
  // one whose key matches openPicker is visible.
  return (
    <>
      {config.fields.map((f, i) => {
        if (f.kind === "account") {
          const opts = f.scope === "investment" ? invOpts : bankOpts;
          return (
            <PickerSheet
              key={`acc-${i}`}
              visible={openPicker === f.key}
              title={f.label}
              options={opts}
              selectedId={form[f.key]}
              onSelect={(id) => onAccountChange(f.key, id)}
              onClose={onClose}
            />
          );
        }
        if (f.kind === "holding") {
          const opts = toHoldingOptions(accountHoldings(ctx.holdings, form[f.accountKey]));
          return (
            <PickerSheet
              key={`hold-${i}`}
              visible={openPicker === f.key}
              title={f.label}
              options={opts}
              selectedId={form[f.key]}
              onSelect={(id) => set({ [f.key]: id } as Partial<OpState>)}
              onClose={onClose}
            />
          );
        }
        if (f.kind === "relatedHolding") {
          const opts: PickerOption[] = [
            { id: -1, label: "None" },
            ...toHoldingOptions(accountHoldings(ctx.holdings, form[f.accountKey])),
          ];
          return (
            <PickerSheet
              key={`rel-${i}`}
              visible={openPicker === "relatedHoldingId"}
              title={f.label}
              options={opts}
              selectedId={form.relatedHoldingId ?? -1}
              onSelect={(id) => set({ relatedHoldingId: id === -1 ? null : id })}
              onClose={onClose}
            />
          );
        }
        if (f.kind === "category") {
          const opts: PickerOption[] = [
            { id: -1, label: "None" },
            ...categories.map((c) => ({ id: c.id, label: safeName(c.name), sublabel: c.group || undefined })),
          ];
          return (
            <PickerSheet
              key={`cat-${i}`}
              visible={openPicker === "categoryId"}
              title={f.label}
              options={opts}
              selectedId={form.categoryId ?? -1}
              onSelect={(id) => set({ categoryId: id === -1 ? null : id })}
              onClose={onClose}
            />
          );
        }
        return null;
      })}
    </>
  );
}

// --- small presentational helpers ---------------------------------------

function FieldCard({ label, colors, children }: { label: string; colors: ThemeColors; children: React.ReactNode }) {
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function SelectField({
  value,
  placeholder,
  sub,
  colors,
  onPress,
}: {
  value: string | null;
  placeholder: string;
  sub?: string;
  colors: ThemeColors;
  onPress: () => void;
}) {
  return (
    <View>
      <TouchableOpacity
        onPress={onPress}
        style={[styles.select, { backgroundColor: colors.secondary, borderColor: colors.border }]}
      >
        <Text
          style={[styles.selectText, { color: value ? colors.foreground : colors.mutedForeground }]}
          numberOfLines={1}
        >
          {value ?? placeholder}
        </Text>
        <Icon name="chevronDown" size={16} color={colors.mutedForeground} />
      </TouchableOpacity>
      {sub ? <Text style={[styles.selectSub, { color: colors.mutedForeground }]}>{sub}</Text> : null}
    </View>
  );
}

function CurrencyChips({
  options,
  value,
  colors,
  onSelect,
}: {
  options: string[];
  value: string;
  colors: ThemeColors;
  onSelect: (c: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {options.map((c) => {
        const active = value.toUpperCase() === c.toUpperCase();
        return (
          <TouchableOpacity
            key={c}
            onPress={() => onSelect(c)}
            style={[
              styles.curChip,
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
  );
}

function accountLabelFor(ctx: OpContext, id: number | null): string | null {
  const a = ctx.accounts.find((x) => x.accountId === id);
  return a ? safeName(a.accountName) : null;
}
function toAccountOptions(accs: AccountBalance[]): PickerOption[] {
  return accs.map((a) => ({ id: a.accountId, label: safeName(a.accountName), sublabel: a.currency }));
}
function toHoldingOptions(hs: PortfolioHoldingRow[]): PickerOption[] {
  return hs.map((h) => ({
    id: h.id,
    label: safeName(h.symbol || h.name),
    sublabel: `${h.currentShares} shares · ${h.currency}`,
  }));
}
function inputStyle(colors: ThemeColors) {
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
  title: { fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center", marginHorizontal: 8 },
  save: { fontSize: 15, fontWeight: "700" },
  scroll: { padding: 16, paddingBottom: 40 },
  amountCard: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    marginBottom: 12,
    alignItems: "center",
  },
  amountLabel: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  amountInputRow: { flexDirection: "row", alignItems: "center" },
  amountPrefix: { fontSize: 30, fontWeight: "700", marginRight: 2 },
  amountInput: {
    fontSize: 34,
    fontWeight: "800",
    minWidth: 120,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 10 },
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
  selectSub: { fontSize: 12, marginTop: 6 },
  chipRow: { gap: 8, paddingVertical: 2 },
  curChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  seg: { flexDirection: "row", borderRadius: 10, padding: 3 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 7, alignItems: "center" },
  lotToggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  lotToggleLabel: { fontSize: 14, fontWeight: "600" },
  switch: { width: 46, height: 28, borderRadius: 14, padding: 3, justifyContent: "center" },
  switchKnob: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#fff" },
  switchKnobOn: { alignSelf: "flex-end" },
  lotBtn: {
    marginTop: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: "center",
  },
  lotBtnText: { fontSize: 14, fontWeight: "700" },
  lotHint: { fontSize: 12, marginTop: 8 },
});
