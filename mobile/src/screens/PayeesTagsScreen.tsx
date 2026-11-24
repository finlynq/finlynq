// More → Payees & tags (2026-11-24): the phone take on the web's Settings →
// Payees & tags, over the same routes. Every payee or tag with how many
// transactions use it, groups of likely duplicates, and Merge / Rename /
// Move to note / Remove. Changes apply to TRANSACTIONS only; what the bank
// sent (bank statement rows) is never changed. Wording in lib/names-cleanup.ts.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  TextInput,
  Modal,
  Switch,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { Icon } from "../components/icon";
import { clearNameOptionsCache } from "../hooks/useNameOptions";
import {
  DUPLICATES_HINT,
  NAMES_INTRO,
  NAMES_LOAD_ERROR,
  NAMES_LOCKED,
  NO_DUPLICATES,
  affectedCount,
  filterNames,
  mergedMessage,
  noun,
  plural,
  resolveGroups,
  tagNameError,
  type NameKind,
  type NameList,
  type NameUsage,
} from "../lib/names-cleanup";

const LIST_CAP = 200;

type Dialog =
  | { mode: "merge"; items: NameUsage[] }
  | { mode: "rename"; items: NameUsage[] }
  | null;

export default function PayeesTagsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const [kind, setKind] = useState<NameKind>("payees");
  const [lists, setLists] = useState<Record<NameKind, NameList | null>>({ payees: null, tags: null });
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (which: NameKind, isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setError(null);
    try {
      const res = which === "payees" ? await endpoints.getPayeeUsage() : await endpoints.getTagUsage();
      if (!alive.current) return;
      if (res.success) {
        const d = res.data as { payees?: NameUsage[]; tags?: NameUsage[]; groups: string[][]; locked: boolean };
        setLists((prev) => ({
          ...prev,
          [which]: { items: (which === "payees" ? d.payees : d.tags) ?? [], groups: d.groups ?? [], locked: !!d.locked },
        }));
      } else {
        logger.warn("names", "load failed", { which, error: res.error });
        setError(NAMES_LOAD_ERROR);
      }
    } catch (e) {
      logger.warn("names", "load threw", { which, error: String(e) });
      if (alive.current) setError(NAMES_LOAD_ERROR);
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isFocused) load(kind);
  }, [isFocused, kind, load]);

  const list = lists[kind];
  const groups = useMemo(() => (list ? resolveGroups(list) : []), [list]);
  const shown = useMemo(() => (list ? filterNames(list.items, query) : []), [list, query]);

  const afterChange = async (message: string) => {
    setNotice(message);
    setOpenKey(null);
    clearNameOptionsCache();
    await load(kind);
  };

  const run = async (label: string, call: () => Promise<{ success: boolean; data?: unknown; error?: string }>, ok: (d: never) => string) => {
    setBusy(true);
    try {
      const res = await call();
      if (!alive.current) return;
      if (res.success) await afterChange(ok(res.data as never));
      else Alert.alert(`Couldn't ${label}`, res.error ?? "Please try again.");
    } catch (e) {
      Alert.alert(`Couldn't ${label}`, String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const confirmMoveToNote = (item: NameUsage) =>
    Alert.alert(
      "Move to note",
      `Move "${item.name}" into the note of ${plural(item.count, "transaction", "transactions")} and leave the payee empty? A note they already have is kept after it. Bank statement rows are not changed.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Move",
          onPress: () =>
            run("move it", () => endpoints.movePayeesToNote([item.key]), (d: { updated: number }) =>
              `Moved the payee into the note on ${plural(d.updated, "transaction", "transactions")}.`,
            ),
        },
      ],
    );

  const confirmRemove = (item: NameUsage) =>
    kind === "tags"
      ? Alert.alert(
          "Remove tag",
          `Remove the tag "${item.name}" from ${plural(item.count, "transaction", "transactions")}? The transactions stay; only the tag goes.`,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Remove",
              style: "destructive",
              onPress: () => run("remove it", () => endpoints.replaceTags([item.key], null), () => `Removed the tag "${item.name}".`),
            },
          ],
        )
      : Alert.alert(
          "Stop suggesting payee",
          `Take "${item.name}" out of the Payee suggestions? Transactions keep their payee. Using it again adds it back.`,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Remove",
              style: "destructive",
              onPress: () =>
                run("remove it", () => endpoints.forgetPayee(item.suggestionId as number), () => `"${item.name}" is no longer suggested.`),
            },
          ],
        );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel="Back">
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          Payees & tags
        </Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(kind, true)} />}
      >
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>{NAMES_INTRO}</Text>

        <View style={[styles.tabs, { backgroundColor: colors.muted }]} accessibilityRole="tablist">
          {(["payees", "tags"] as const).map((k) => {
            const on = kind === k;
            return (
              <TouchableOpacity
                key={k}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => {
                  setKind(k);
                  setQuery("");
                  setOpenKey(null);
                  setNotice(null);
                }}
                style={[styles.tab, on && { backgroundColor: colors.card }]}
              >
                <Text style={[styles.tabText, { color: on ? colors.foreground : colors.mutedForeground }]}>
                  {k === "payees" ? "Payees" : "Tags"}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {notice ? (
          <View style={[styles.notice, { backgroundColor: colors.card, borderColor: colors.pos }]} accessibilityRole="alert">
            <Text style={[styles.body, { color: colors.foreground, flex: 1 }]}>{notice}</Text>
            <TouchableOpacity onPress={() => setNotice(null)} accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={8}>
              <Icon name="close" size={14} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        ) : null}

        {error && !list ? (
          <View accessibilityRole="alert">
            <Text style={[styles.body, { color: colors.destructive }]}>{error}</Text>
            <TouchableOpacity onPress={() => load(kind)} accessibilityRole="button" style={styles.retry}>
              <Text style={[styles.link, { color: colors.primary }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : !list ? (
          <ActivityIndicator style={{ marginVertical: 32 }} size="large" color={colors.primary} />
        ) : list.locked ? (
          <Text style={[styles.body, { color: colors.foreground }]}>{NAMES_LOCKED}</Text>
        ) : (
          <>
            <Text style={[styles.section, { color: colors.foreground }]}>Likely duplicates</Text>
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>{DUPLICATES_HINT}</Text>
            {groups.length === 0 ? (
              <Text style={[styles.body, { color: colors.mutedForeground }]}>{NO_DUPLICATES}</Text>
            ) : (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {groups.slice(0, 30).map((g, gi) => (
                  <View
                    key={g.map((i) => i.key).join("|")}
                    style={[styles.group, gi > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
                  >
                    <View style={styles.groupNames}>
                      {g.map((i) => (
                        <View key={i.key} style={[styles.pill, { borderColor: colors.border }]}>
                          <Text style={[styles.pillText, { color: colors.foreground }]} numberOfLines={1}>
                            {i.name}
                          </Text>
                          <Text style={[styles.count, { color: colors.mutedForeground }]}>{i.count}</Text>
                        </View>
                      ))}
                    </View>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={`Merge ${g.map((i) => i.name).join(", ")}`}
                      onPress={() => setDialog({ mode: "merge", items: g })}
                      style={[styles.smallBtn, { backgroundColor: colors.primary }]}
                    >
                      <Text style={[styles.smallBtnText, { color: colors.primaryForeground }]}>Merge</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            <Text style={[styles.section, { color: colors.foreground }]}>
              All {noun(kind, true)} ({list.items.length.toLocaleString()})
            </Text>
            <TextInput
              accessibilityLabel={`Search ${noun(kind, true)}`}
              value={query}
              onChangeText={setQuery}
              placeholder={`Search ${noun(kind, true)}`}
              placeholderTextColor={colors.mutedForeground}
              style={[styles.search, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
            />
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {shown.length === 0 ? (
                <Text style={[styles.body, styles.empty, { color: colors.mutedForeground }]}>
                  No {noun(kind, true)} {query ? "match your search" : "yet"}.
                </Text>
              ) : (
                shown.slice(0, LIST_CAP).map((i, idx) => {
                  const open = openKey === i.key;
                  return (
                    <View key={i.key} style={idx > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={i.name}
                        accessibilityState={{ expanded: open }}
                        onPress={() => setOpenKey(open ? null : i.key)}
                        style={styles.row}
                      >
                        <View style={styles.rowMain}>
                          <Text style={[styles.rowTitle, { color: colors.foreground }]}>{i.name}</Text>
                          <Text style={[styles.rowSub, { color: colors.mutedForeground }]}>
                            {plural(i.count, "transaction", "transactions")}
                            {i.lastDate ? ` · last ${i.lastDate}` : ""}
                            {kind === "payees" && i.suggestionId != null ? " · suggested" : ""}
                          </Text>
                          {(i.variants?.length ?? 0) > 0 ? (
                            <Text style={[styles.rowSub, { color: colors.mutedForeground }]} numberOfLines={2}>
                              also written {i.variants!.join(", ")}
                            </Text>
                          ) : null}
                        </View>
                        <Icon name={open ? "chevronDown" : "chevronRight"} size={16} color={colors.mutedForeground} />
                      </TouchableOpacity>
                      {open ? (
                        <View style={styles.actions}>
                          <ActionButton label="Rename" disabled={busy} onPress={() => setDialog({ mode: "rename", items: [i] })} />
                          {kind === "payees" && i.count > 0 ? (
                            <ActionButton label="Move to note" disabled={busy} onPress={() => confirmMoveToNote(i)} />
                          ) : null}
                          {kind === "tags" || i.suggestionId != null ? (
                            <ActionButton label="Remove" danger disabled={busy} onPress={() => confirmRemove(i)} />
                          ) : null}
                        </View>
                      ) : null}
                    </View>
                  );
                })
              )}
            </View>
            {shown.length > LIST_CAP ? (
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                Showing {LIST_CAP} of {shown.length.toLocaleString()}. Search to find others.
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>

      {dialog && list ? (
        <NameDialog
          kind={kind}
          dialog={dialog}
          existing={list.items}
          onClose={() => setDialog(null)}
          onDone={async (message) => {
            setDialog(null);
            await afterChange(message);
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

function ActionButton({ label, onPress, danger, disabled }: { label: string; onPress: () => void; danger?: boolean; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      style={[styles.actionBtn, { borderColor: danger ? colors.destructive : colors.border, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={[styles.actionText, { color: danger ? colors.destructive : colors.foreground }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Merge (several names into one) or rename (one name, maybe onto another). */
function NameDialog({
  kind,
  dialog,
  existing,
  onClose,
  onDone,
}: {
  kind: NameKind;
  dialog: NonNullable<Dialog>;
  existing: NameUsage[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const { colors } = useTheme();
  const ordered = useMemo(() => [...dialog.items].sort((a, b) => b.count - a.count), [dialog.items]);
  const [included, setIncluded] = useState<Set<string>>(() => new Set(dialog.items.map((i) => i.key)));
  const [target, setTarget] = useState(ordered[0]?.name ?? "");
  const [addRules, setAddRules] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = dialog.mode === "rename";
  const chosen = ordered.filter((i) => included.has(i.key));
  const trimmed = target.trim();
  const clash = rename
    ? existing.find((e) => e.key !== dialog.items[0].key && e.name.toLowerCase() === trimmed.toLowerCase())
    : undefined;
  const nameError = kind === "tags" ? (trimmed ? tagNameError(trimmed) : null) : null;
  const canSave = !saving && trimmed !== "" && !nameError && (rename || chosen.length >= 2);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const sources = chosen.map((i) => i.key);
      if (kind === "payees") {
        const res = await endpoints.mergePayees(sources, trimmed, addRules);
        if (!res.success) {
          setError(res.error ?? "Couldn't save the change.");
          return;
        }
        await onDone(mergedMessage(res.data.updated, trimmed, res.data.rulesAdded));
      } else {
        const res = await endpoints.replaceTags(sources, trimmed);
        if (!res.success) {
          setError(res.error ?? "Couldn't save the change.");
          return;
        }
        await onDone(mergedMessage(res.data.updated, trimmed));
      }
    } catch {
      setError("Couldn't save the change. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => !saving && onClose()}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
              {rename ? `Rename ${noun(kind)}` : `Merge ${plural(dialog.items.length, noun(kind), noun(kind, true))}`}
            </Text>
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Changes the {noun(kind)} on your transactions. Bank statement rows keep what the bank sent.
            </Text>
            {!rename ? (
              <View style={[styles.card, { borderColor: colors.border }]}>
                {ordered.map((i, idx) => {
                  const on = included.has(i.key);
                  return (
                    <View
                      key={i.key}
                      style={[styles.mergeRow, idx > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
                    >
                      <TouchableOpacity
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on }}
                        accessibilityLabel={`Include ${i.name}`}
                        hitSlop={8}
                        onPress={() =>
                          setIncluded((s) => {
                            const n = new Set(s);
                            if (n.has(i.key)) n.delete(i.key);
                            else n.add(i.key);
                            return n;
                          })
                        }
                        style={[styles.check, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary : "transparent" }]}
                      >
                        {on ? <Icon name="check" size={12} color={colors.primaryForeground} /> : null}
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`Keep ${i.name}`}
                        onPress={() => setTarget(i.name)}
                        style={styles.mergeName}
                      >
                        <Text style={[styles.body, { color: colors.foreground, flex: 1 }]} numberOfLines={2}>
                          {i.name}
                        </Text>
                        <Text style={[styles.count, { color: colors.mutedForeground }]}>{i.count}</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            ) : null}
            {!rename ? (
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>Tap a name to keep it, or type a new one.</Text>
            ) : null}
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{rename ? "NEW NAME" : "KEEP AS"}</Text>
            <TextInput
              accessibilityLabel={rename ? "New name" : "Keep as"}
              value={target}
              onChangeText={setTarget}
              autoCorrect={false}
              style={[styles.search, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
            />
            {clash ? (
              <Text style={[styles.hint, { color: colors.destructive }]}>
                You already have "{clash.name}". Renaming will put both under one name.
              </Text>
            ) : null}
            {nameError ? <Text style={[styles.hint, { color: colors.destructive }]}>{nameError}</Text> : null}
            {kind === "payees" ? (
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.body, { color: colors.foreground }]}>Also rename these on future imports</Text>
                  <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                    Adds a rule for each old spelling. Rules apply to rows from bank feeds and statements.
                  </Text>
                </View>
                <Switch value={addRules} onValueChange={setAddRules} accessibilityLabel="Also rename these on future imports" />
              </View>
            ) : null}
            <Text style={[styles.body, { color: colors.foreground }]}>
              {plural(affectedCount(chosen), "transaction", "transactions")} will get the {noun(kind)} "{trimmed || "…"}".
            </Text>
            {error ? (
              <Text style={[styles.body, { color: colors.destructive }]} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
            <View style={styles.sheetButtons}>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={saving ? undefined : onClose}
                style={[styles.sheetBtn, { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth }]}
              >
                <Text style={[styles.actionText, { color: colors.foreground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={rename ? "Confirm rename" : "Confirm merge"}
                accessibilityState={{ disabled: !canSave }}
                onPress={canSave ? save : undefined}
                style={[styles.sheetBtn, { backgroundColor: colors.primary, opacity: canSave ? 1 : 0.5 }]}
              >
                <Text style={[styles.actionText, { color: colors.primaryForeground }]}>
                  {saving ? "Saving…" : rename ? "Rename" : "Merge"}
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { flexDirection: "row", alignItems: "center", gap: 2, width: 70 },
  backText: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700", flex: 1, textAlign: "center" },
  scroll: { padding: 16, paddingBottom: 40, gap: 12 },
  hint: { fontSize: 12, lineHeight: 17 },
  body: { fontSize: 14, lineHeight: 20 },
  label: { fontSize: 12, fontWeight: "600" },
  section: { fontSize: 15, fontWeight: "700", marginTop: 4 },
  retry: { marginTop: 4, alignSelf: "flex-start", paddingVertical: 6 },
  link: { fontSize: 14, fontWeight: "700" },
  tabs: { flexDirection: "row", borderRadius: 10, padding: 3 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8, minHeight: 36, justifyContent: "center" },
  tabText: { fontSize: 13, fontWeight: "700" },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderWidth: 1, borderRadius: 10, padding: 10 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  group: { padding: 12, gap: 10 },
  groupNames: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    maxWidth: "100%",
  },
  pillText: { fontSize: 13, flexShrink: 1 },
  count: { fontSize: 12 },
  smallBtn: { alignSelf: "flex-start", borderRadius: 8, paddingHorizontal: 14, minHeight: 36, justifyContent: "center" },
  smallBtnText: { fontSize: 14, fontWeight: "700" },
  search: { fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  empty: { padding: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, minHeight: 52 },
  rowMain: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: "600" },
  rowSub: { fontSize: 12 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 14, paddingBottom: 12 },
  actionBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, minHeight: 36, justifyContent: "center" },
  actionText: { fontSize: 14, fontWeight: "700" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", paddingTop: 60, paddingHorizontal: 16 },
  sheet: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 16, maxHeight: "90%" },
  sheetTitle: { fontSize: 17, fontWeight: "700" },
  mergeRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, minHeight: 48 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  mergeName: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  sheetButtons: { flexDirection: "row", gap: 10, marginTop: 4 },
  sheetBtn: { flex: 1, borderRadius: 10, minHeight: 44, alignItems: "center", justifyContent: "center" },
});
