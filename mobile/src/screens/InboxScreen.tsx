// InboxScreen — account-anchored reconcile inbox (P3 mobile parity).
//
// Ports the phone-native card lenses from web /inbox: Approve-each
// (mode='approve' → "To approve" cards) and Auto-pilot (mode='auto' → "To
// categorize" cards), plus a read-only Reconciled tab and a per-account mode
// picker. The two-pane N×M grid + Manual-mode staging review stay web-only;
// when the active lens is 'manual' this screen surfaces a "use the web app"
// notice and the Reconciled tab only.
//
// The screen owns the snapshot fetch (GET /api/reconcile/suggestions), the
// category list, the category picker, and every commit/delete handler so the
// tab bodies (InboxCardList / ReconciledTab) stay presentational.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { safeName, safeAccountName } from "../lib/format";
import { Icon } from "../components/icon";
import { PickerSheet, type PickerOption } from "../components/picker-sheet";
import { InboxCardList } from "../components/inbox/InboxCardList";
import { ReconciledTab } from "../components/inbox/ReconciledTab";
import { ModePicker } from "../components/inbox/ModePicker";
import {
  MODE_META,
  buildSuggestionByBank,
  isMode,
  resolveSuggestedCategoryId,
  unlinkedBankRows,
} from "../lib/inbox";
import type {
  AccountMode,
  Category,
  InboxAccount,
  ReconcileSuggestions,
} from "../../../shared/types";

type InboxRoute = RouteProp<{ Inbox?: { accountId?: number } }, "Inbox">;

const CARD_LENSES: AccountMode[] = ["auto", "approve", "manual"];

function defaultTabFor(lens: AccountMode): "cards" | "reconciled" {
  return lens === "manual" ? "reconciled" : "cards";
}

export default function InboxScreen() {
  const { colors } = useTheme();
  const route = useRoute<InboxRoute>();
  const deepLinkAccountId = route.params?.accountId;

  const [accounts, setAccounts] = useState<InboxAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);

  const [accountId, setAccountId] = useState<number | null>(null);
  const [lens, setLens] = useState<AccountMode | null>(null);
  const [tab, setTab] = useState<"cards" | "reconciled">("cards");

  const [snapshot, setSnapshot] = useState<ReconcileSuggestions | null>(null);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyBankId, setBusyBankId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [pickerBankId, setPickerBankId] = useState<string | null>(null);
  const [showModePicker, setShowModePicker] = useState(false);

  // ─── Load accounts + categories once ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAccountsLoading(true);
      try {
        const [accRes, catRes] = await Promise.all([
          endpoints.getInboxAccounts(),
          endpoints.getCategories(),
        ]);
        if (cancelled) return;
        if (accRes.success) {
          const normalized = accRes.data.map((a) => ({
            ...a,
            mode: isMode(a.mode) ? a.mode : ("manual" as AccountMode),
          }));
          setAccounts(normalized);
          setAccountsError(null);
          // Investment accounts have no card flow on mobile (approve/categorize
          // refuse them server-side) — exclude them from the selector.
          const usable = normalized.filter((a) => !a.archived && !a.isInvestment);
          const pick =
            deepLinkAccountId != null && usable.some((a) => a.id === deepLinkAccountId)
              ? deepLinkAccountId
              : (usable[0]?.id ?? null);
          setAccountId(pick);
          const picked = usable.find((a) => a.id === pick);
          const policy = picked?.mode ?? "manual";
          setLens(policy);
          setTab(defaultTabFor(policy));
        } else {
          logger.warn("inbox", "accounts fetch failed", { error: accRes.error });
          setAccountsError(accRes.error);
        }
        if (catRes.success) setCategories(catRes.data);
        else logger.warn("inbox", "categories fetch failed", { error: catRes.error });
      } catch (e) {
        if (cancelled) return;
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("inbox", "load threw", { detail });
        setAccountsError("Cannot connect to server");
      } finally {
        if (!cancelled) setAccountsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // deepLinkAccountId only matters on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleAccounts = useMemo(
    () => accounts.filter((a) => !a.archived && !a.isInvestment),
    [accounts],
  );
  const account = useMemo(
    () => accounts.find((a) => a.id === accountId) ?? null,
    [accounts, accountId],
  );
  const policy: AccountMode = account?.mode ?? "manual";
  const activeLens: AccountMode = lens ?? policy;
  const isLensActive = activeLens !== policy;

  // ─── Snapshot fetch (per account) ───────────────────────────────────────
  const fetchSnapshot = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (accountId == null) return;
      if (!opts?.silent) setSnapLoading(true);
      setSnapError(null);
      try {
        const res = await endpoints.getReconcileSuggestions(accountId);
        if (res.success) {
          setSnapshot(res.data);
        } else {
          logger.warn("inbox", "suggestions fetch failed", { error: res.error });
          setSnapError(res.error);
          setSnapshot(null);
        }
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("inbox", "suggestions threw", { detail });
        setSnapError("Cannot connect to server");
        setSnapshot(null);
      } finally {
        setSnapLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    setSnapshot(null);
    void fetchSnapshot();
  }, [fetchSnapshot]);

  // ─── Category helpers ───────────────────────────────────────────────────
  const categoryNameById = useCallback(
    (id: number) => {
      const c = categories.find((x) => x.id === id);
      return safeName(c?.name, `Category #${id}`);
    },
    [categories],
  );
  const categoryIdByName = useCallback(
    (name: string) => {
      const c = categories.find((x) => x.name === name);
      return c ? c.id : null;
    },
    [categories],
  );
  const categoryOptions: PickerOption[] = useMemo(
    () =>
      categories.map((c) => ({
        id: c.id,
        label: safeName(c.name, `Category #${c.id}`),
        sublabel:
          (c.group ? `${c.group} · ` : "") +
          (c.type === "I" ? "Income" : c.type === "E" ? "Expense" : "Reconciliation"),
      })),
    [categories],
  );

  // ─── Derived card data ──────────────────────────────────────────────────
  const unlinked = useMemo(() => unlinkedBankRows(snapshot), [snapshot]);
  const suggestionByBank = useMemo(
    () => buildSuggestionByBank(snapshot, categoryNameById),
    [snapshot, categoryNameById],
  );
  const suggestedUnlinked = useMemo(
    () => unlinked.filter((b) => suggestionByBank.has(b.id)),
    [unlinked, suggestionByBank],
  );

  // ─── Account / lens switching ───────────────────────────────────────────
  const selectAccount = (id: number) => {
    setAccountId(id);
    setSnapshot(null);
    setActionError(null);
    const next = accounts.find((a) => a.id === id);
    const nextPolicy: AccountMode = next?.mode ?? "manual";
    setLens(nextPolicy);
    setTab(defaultTabFor(nextPolicy));
    setShowModePicker(false);
  };

  const changeLens = (m: AccountMode) => {
    setLens(m);
    setTab(defaultTabFor(m));
    setActionError(null);
  };

  const saveDefault = useCallback(async () => {
    if (account == null || !isLensActive) return;
    setSavingPolicy(true);
    setActionError(null);
    try {
      const res = await endpoints.setAccountMode(account.id, activeLens);
      if (res.success) {
        const newMode: AccountMode = isMode(res.data?.mode) ? res.data.mode : activeLens;
        setAccounts((prev) =>
          prev.map((a) => (a.id === account.id ? { ...a, mode: newMode } : a)),
        );
        setLens(newMode);
      } else {
        setActionError(res.error);
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("inbox", "save default threw", { detail });
      setActionError("Cannot connect to server");
    } finally {
      setSavingPolicy(false);
    }
  }, [account, activeLens, isLensActive]);

  // ─── Commit (approve / categorize) ──────────────────────────────────────
  const commit = useCallback(
    async (bankId: string, categoryId: number) => {
      // Manual lens shows no cards, so commit is only reachable from
      // approve/auto. Approve-each → /approve; Auto-pilot → /categorize.
      const fn =
        activeLens === "approve" ? endpoints.approveBankRow : endpoints.categorizeBankRow;
      setBusyBankId(bankId);
      setActionError(null);
      try {
        const res = await fn(bankId, { categoryId });
        if (res.ok) {
          await fetchSnapshot({ silent: true });
        } else {
          // Server-authoritative sign-vs-category + investment refusals.
          setActionError(res.error?.error ?? "Failed to commit row");
        }
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("inbox", "commit threw", { detail });
        setActionError("Cannot connect to server");
      } finally {
        setBusyBankId(null);
      }
    },
    [activeLens, fetchSnapshot],
  );

  const onPrimary = useCallback(
    (bankId: string) => {
      const sug = suggestionByBank.get(bankId) ?? null;
      const categoryId = resolveSuggestedCategoryId(sug, categoryIdByName);
      if (categoryId != null) {
        void commit(bankId, categoryId);
      } else {
        // No resolvable category (e.g. a 'match' suggestion) → let the user pick.
        setPickerBankId(bankId);
      }
    },
    [suggestionByBank, categoryIdByName, commit],
  );

  const onPickCategory = useCallback(
    (categoryId: number) => {
      const bankId = pickerBankId;
      setPickerBankId(null);
      if (bankId != null) void commit(bankId, categoryId);
    },
    [pickerBankId, commit],
  );

  const onDelete = useCallback(
    (bankId: string) => {
      Alert.alert(
        "Delete bank row",
        "Remove this row from the bank ledger? This can't be undone.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              setBusyBankId(bankId);
              setActionError(null);
              try {
                const res = await endpoints.deleteBankRow(bankId);
                if (res.success) {
                  await fetchSnapshot({ silent: true });
                } else {
                  setActionError(res.error);
                }
              } catch (e) {
                const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                logger.error("inbox", "delete threw", { detail });
                setActionError("Cannot connect to server");
              } finally {
                setBusyBankId(null);
              }
            },
          },
        ],
      );
    },
    [fetchSnapshot],
  );

  const onApproveAll = useCallback(async () => {
    if (suggestedUnlinked.length === 0) return;
    setBulkBusy(true);
    setActionError(null);
    const errors: string[] = [];
    for (const b of suggestedUnlinked) {
      const categoryId = resolveSuggestedCategoryId(
        suggestionByBank.get(b.id),
        categoryIdByName,
      );
      if (categoryId == null) {
        errors.push(`${safeName(b.payee, b.id)}: no category resolved`);
        continue;
      }
      try {
        const res = await endpoints.approveBankRow(b.id, { categoryId });
        if (!res.ok) errors.push(`${safeName(b.payee, b.id)}: ${res.error?.error ?? "failed"}`);
      } catch (e) {
        errors.push(`${safeName(b.payee, b.id)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await fetchSnapshot({ silent: true });
    setBulkBusy(false);
    if (errors.length > 0) {
      setActionError(
        `Approved ${suggestedUnlinked.length - errors.length}/${suggestedUnlinked.length}. Skipped:\n${errors.join("\n")}`,
      );
    }
  }, [suggestedUnlinked, suggestionByBank, categoryIdByName, fetchSnapshot]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchSnapshot({ silent: true });
    setRefreshing(false);
  }, [fetchSnapshot]);

  // ─── Render ─────────────────────────────────────────────────────────────
  if (accountsLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (accountsError) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
        <Header colors={colors} />
        <Text style={[styles.notice, { color: colors.neg }]}>{accountsError}</Text>
      </SafeAreaView>
    );
  }

  if (visibleAccounts.length === 0 || account == null) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
        <Header colors={colors} />
        <Text style={[styles.notice, { color: colors.mutedForeground }]}>
          No reconcilable accounts yet. Add a non-investment account to start reconciling.
        </Text>
      </SafeAreaView>
    );
  }

  const lensMeta = MODE_META[activeLens];
  const cardsTabLabel = activeLens === "approve" ? "To approve" : "To categorize";
  const tabs: Array<{ key: "cards" | "reconciled"; label: string }> =
    activeLens === "manual"
      ? [{ key: "reconciled", label: "Reconciled" }]
      : [
          { key: "cards", label: cardsTabLabel },
          { key: "reconciled", label: "Reconciled" },
        ];
  const effectiveTab: "cards" | "reconciled" =
    activeLens === "manual" ? "reconciled" : tab;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <Header colors={colors} />

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Account selector */}
        <TouchableOpacity
          style={[styles.accountField, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => setAccountPickerOpen(true)}
        >
          <View style={styles.accountFieldText}>
            <Text style={[styles.accountFieldLabel, { color: colors.mutedForeground }]}>ACCOUNT</Text>
            <Text style={[styles.accountFieldName, { color: colors.foreground }]} numberOfLines={1}>
              {safeAccountName(account)} · {account.currency}
            </Text>
          </View>
          <Icon name="chevronDown" size={18} color={colors.mutedForeground} />
        </TouchableOpacity>

        {/* Lens chips ("View as") */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>VIEW AS</Text>
        <View style={styles.chipRow}>
          {CARD_LENSES.map((m) => {
            const meta = MODE_META[m];
            const active = m === activeLens;
            return (
              <TouchableOpacity
                key={m}
                onPress={() => changeLens(m)}
                style={[
                  styles.chip,
                  {
                    borderColor: active ? colors[meta.tone] : colors.border,
                    backgroundColor: active ? colors.secondary : colors.card,
                  },
                ]}
              >
                <Icon name={meta.icon} size={14} color={active ? colors[meta.tone] : colors.mutedForeground} />
                <Text
                  style={[
                    styles.chipText,
                    { color: active ? colors.foreground : colors.mutedForeground },
                  ]}
                >
                  {meta.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={[styles.lensSub, { color: colors.mutedForeground }]}>{lensMeta.subLabel}</Text>

        {/* Lens-active toast — offer to persist the temporary lens as policy. */}
        {isLensActive && (
          <View style={[styles.toast, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.toastText, { color: colors.mutedForeground }]}>
              Viewing as {MODE_META[activeLens].label} · default is {MODE_META[policy].label}
            </Text>
            <TouchableOpacity
              style={[styles.toastBtn, { backgroundColor: colors.primary }, savingPolicy && styles.disabled]}
              onPress={() => void saveDefault()}
              disabled={savingPolicy}
            >
              <Text style={[styles.toastBtnText, { color: colors.primaryForeground }]}>
                {savingPolicy ? "Saving…" : "Make default"}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Collapsible default-mode picker (shared ModePicker). */}
        <TouchableOpacity
          style={styles.disclosure}
          onPress={() => setShowModePicker((s) => !s)}
        >
          <Text style={[styles.disclosureText, { color: colors.foreground }]}>
            Default reconciliation mode
          </Text>
          <Icon name={showModePicker ? "chevronDown" : "chevronRight"} size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
        {showModePicker && (
          <View style={styles.modePickerWrap}>
            <ModePicker
              key={`${account.id}:${policy}`}
              accountId={account.id}
              initialMode={policy}
              onSaved={(m) => {
                setAccounts((prev) =>
                  prev.map((a) => (a.id === account.id ? { ...a, mode: m } : a)),
                );
                setLens(m);
                setTab(defaultTabFor(m));
              }}
            />
          </View>
        )}

        {/* Tabs */}
        <View style={[styles.tabRow, { backgroundColor: colors.secondary }]}>
          {tabs.map((t) => {
            const active = effectiveTab === t.key;
            return (
              <TouchableOpacity
                key={t.key}
                style={[styles.tabBtn, active && { backgroundColor: colors.card }]}
                onPress={() => setTab(t.key)}
              >
                <Text
                  style={[
                    styles.tabText,
                    { color: active ? colors.foreground : colors.mutedForeground },
                  ]}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {actionError && (
          <Text style={[styles.actionError, { color: colors.neg }]}>{actionError}</Text>
        )}

        {/* Tab body */}
        {snapLoading && snapshot == null ? (
          <ActivityIndicator style={{ marginTop: 24 }} size="large" color={colors.primary} />
        ) : snapError ? (
          <Text style={[styles.notice, { color: colors.neg }]}>{snapError}</Text>
        ) : activeLens === "manual" ? (
          <>
            <View style={[styles.manualNotice, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Icon name="eye" size={18} color={colors.mutedForeground} />
              <Text style={[styles.manualNoticeText, { color: colors.mutedForeground }]}>
                Manual review uses the two-pane staging + reconcile flow, available on the web app.
                Switch the view above to Approve-each or Auto-pilot to work this account here.
              </Text>
            </View>
            <ReconciledTab snapshot={snapshot} accountId={account.id} />
          </>
        ) : effectiveTab === "cards" ? (
          <InboxCardList
            lens={activeLens}
            rows={unlinked}
            suggestionByBank={suggestionByBank}
            busyBankId={busyBankId}
            bulkBusy={bulkBusy}
            suggestedCount={suggestedUnlinked.length}
            onPrimary={onPrimary}
            onChooseCategory={(bankId) => setPickerBankId(bankId)}
            onDelete={onDelete}
            onApproveAll={onApproveAll}
          />
        ) : (
          <ReconciledTab
            snapshot={snapshot}
            accountId={account.id}
            showAutoRuleBanner={activeLens === "auto"}
          />
        )}
      </ScrollView>

      <PickerSheet
        visible={accountPickerOpen}
        title="Select account"
        options={visibleAccounts.map((a) => ({
          id: a.id,
          label: safeAccountName(a),
          sublabel: a.currency,
        }))}
        selectedId={accountId}
        onSelect={selectAccount}
        onClose={() => setAccountPickerOpen(false)}
      />
      <PickerSheet
        visible={pickerBankId != null}
        title="Choose a category"
        options={categoryOptions}
        selectedId={
          pickerBankId != null
            ? (() => {
                const sug = suggestionByBank.get(pickerBankId);
                return sug?.kind === "create" ? sug.categoryId : null;
              })()
            : null
        }
        onSelect={onPickCategory}
        onClose={() => setPickerBankId(null)}
      />
    </SafeAreaView>
  );
}

function Header({ colors }: { colors: ReturnType<typeof useTheme>["colors"] }) {
  return (
    <View style={styles.headerRow}>
      <Text style={[styles.header, { color: colors.foreground }]}>Reconcile</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  header: { fontSize: 28, fontWeight: "800" },
  scroll: { padding: 16, paddingBottom: 48 },
  notice: { fontSize: 14, textAlign: "center", paddingVertical: 24, paddingHorizontal: 8, lineHeight: 20 },
  accountField: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 14,
  },
  accountFieldText: { flex: 1 },
  accountFieldLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  accountFieldName: { fontSize: 16, fontWeight: "700", marginTop: 2 },
  sectionLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5, marginBottom: 6 },
  chipRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  chip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 9,
  },
  chipText: { fontSize: 12, fontWeight: "600" },
  lensSub: { fontSize: 12, marginBottom: 12 },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  toastText: { flex: 1, fontSize: 12 },
  toastBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  toastBtnText: { fontSize: 12, fontWeight: "700" },
  disclosure: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  disclosureText: { fontSize: 13, fontWeight: "600" },
  modePickerWrap: { marginBottom: 12 },
  tabRow: { flexDirection: "row", padding: 3, borderRadius: 10, marginBottom: 12 },
  tabBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
  tabText: { fontSize: 13, fontWeight: "600" },
  actionError: { fontSize: 12, marginBottom: 10, lineHeight: 17 },
  manualNotice: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  manualNoticeText: { flex: 1, fontSize: 12, lineHeight: 18 },
  disabled: { opacity: 0.5 },
});
