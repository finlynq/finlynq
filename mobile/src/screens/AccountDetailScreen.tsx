import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, safeName, safeAccountName, formatShortDate } from "../lib/format";
import { Icon } from "../components/icon";
import { ModePicker } from "../components/inbox/ModePicker";
import type { AccountDetailRow, Transaction } from "../../../shared/types";
import type { AccountsStackParamList } from "../navigation/AccountsStack";

type Props = NativeStackScreenProps<AccountsStackParamList, "AccountDetail">;

export default function AccountDetailScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const { account } = route.params;
  const isFocused = useIsFocused();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Full decrypted account row (mode/type/group/note/alias/archived) for the
  // manage footer — fetched separately from the balance row this screen is
  // handed. `null` until it loads (manage actions stay hidden meanwhile).
  const [detail, setDetail] = useState<AccountDetailRow | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await endpoints.getTransactions(
          `accountId=${account.accountId}&limit=50&sort=date&sortDir=desc`
        );
        if (res.success) {
          setTransactions(res.data);
          setError(null);
        } else {
          logger.warn("account-detail", "transactions fetch failed", { error: res.error });
          setError(res.error);
        }
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        logger.error("account-detail", "fetch threw", { detail });
        setError("Cannot connect to server");
      } finally {
        setLoading(false);
      }
    })();
  }, [account.accountId]);

  // Load (and re-load on focus, so an edit/mode change is reflected on return)
  // the full account row for the manage footer.
  const loadDetail = useCallback(async () => {
    const res = await endpoints.getAccountsDetailed();
    if (res.success) {
      setDetail(res.data.find((a) => a.id === account.accountId) ?? null);
    } else {
      logger.warn("account-detail", "detail fetch failed", { error: res.error });
    }
  }, [account.accountId]);

  useEffect(() => {
    if (isFocused) loadDetail();
  }, [isFocused, loadDetail]);

  const value = account.convertedBalance ?? account.balance;
  const currency = account.displayCurrency ?? account.currency;
  // Prefer the freshly-loaded detail name (reflects edits) over the route param.
  const heroName = detail
    ? safeAccountName({ id: detail.id, name: detail.name, alias: detail.alias })
    : safeName(account.accountName);

  const handleEdit = () => {
    if (detail) navigation.navigate("AddAccount", { account: detail });
  };

  const handleArchive = () => {
    if (!detail) return;
    Alert.alert(
      "Archive account?",
      "It will be hidden from your accounts list. You can unarchive it on the web app.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Archive",
          onPress: async () => {
            setWorking(true);
            try {
              const res = await endpoints.updateAccount({ id: detail.id, archived: true });
              if (res.success) {
                logger.info("account-detail", "account archived", { id: detail.id });
                navigation.goBack();
              } else {
                Alert.alert("Couldn't archive", res.error || "Please try again.");
              }
            } catch (e) {
              const d = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
              logger.error("account-detail", "archive threw", { detail: d });
              Alert.alert("Error", "Cannot connect to server");
            } finally {
              setWorking(false);
            }
          },
        },
      ]
    );
  };

  const handleDelete = () => {
    if (!detail) return;
    Alert.alert(
      "Delete account?",
      "This permanently removes the account. Accounts with linked transactions can't be deleted — archive them instead.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setWorking(true);
            try {
              const res = await endpoints.deleteAccountById(detail.id);
              if (res.success) {
                logger.info("account-detail", "account deleted", { id: detail.id });
                navigation.goBack();
              } else {
                // 409 carries the "archive it instead" message verbatim.
                Alert.alert("Couldn't delete", res.error || "Please try again.");
              }
            } catch (e) {
              const d = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
              logger.error("account-detail", "delete threw", { detail: d });
              Alert.alert("Error", "Cannot connect to server");
            } finally {
              setWorking(false);
            }
          },
        },
      ]
    );
  };

  // Cross-tab deep-link to the reconcile inbox (lives in the More stack). The
  // parent tab navigator owns the More route; a minimal typed cast keeps this
  // off `any` without importing the whole nested param map.
  const goToReconcile = () => {
    type RootTabNav = {
      navigate: (
        tab: "More",
        params: { screen: "Inbox"; params: { accountId: number } },
      ) => void;
    };
    (navigation.getParent() as unknown as RootTabNav | undefined)?.navigate("More", {
      screen: "Inbox",
      params: { accountId: account.accountId },
    });
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.topBar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Icon name="back" size={20} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>Accounts</Text>
        </TouchableOpacity>
        {/* Investment accounts use the web portfolio flow; hide quick-add there. */}
        {!account.isInvestment && (
          <TouchableOpacity
            style={[styles.addBtn, { backgroundColor: colors.primary }]}
            onPress={() =>
              navigation.navigate("AddTransaction", {
                mode: "expense",
                preselectedAccountId: account.accountId,
              })
            }
          >
            <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>
              + Add transaction
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={transactions}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={[styles.hero, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.accountName, { color: colors.foreground }]} numberOfLines={2}>
              {heroName}
            </Text>
            <Text style={[styles.accountMeta, { color: colors.mutedForeground }]}>
              {account.accountGroup} · {account.currency}
              {account.accountType === "L" ? " · Liability" : ""}
            </Text>
            <Text style={[styles.heroValue, { color: colors.foreground }]}>
              {formatCurrency(value, currency, { decimals: 2 })}
            </Text>
            {account.isInvestment && (account.holdingsValue ?? 0) !== 0 && (
              <Text style={[styles.holdingsHint, { color: colors.mutedForeground }]}>
                Market value (holdings) ·{" "}
                <Text style={{ color: colors.mutedForeground }}>manage on web</Text>
              </Text>
            )}
            {/* Reconcile inbox — non-investment accounts only (the card lenses
                refuse investment accounts server-side). */}
            {!account.isInvestment && (
              <TouchableOpacity
                style={[styles.reconcileBtn, { borderColor: colors.border }]}
                onPress={goToReconcile}
              >
                <Icon name="inbox" size={15} color={colors.primary} />
                <Text style={[styles.reconcileText, { color: colors.primary }]}>
                  Reconcile this account
                </Text>
              </TouchableOpacity>
            )}
            <Text style={[styles.activityLabel, { color: colors.mutedForeground }]}>
              Recent activity
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.txRow, { borderBottomColor: colors.border }]}>
            <View style={styles.txLeft}>
              <Text style={[styles.txPayee, { color: colors.foreground }]} numberOfLines={1}>
                {safeName(item.payee || item.note, "Transaction")}
              </Text>
              <Text style={[styles.txDate, { color: colors.mutedForeground }]}>
                {formatShortDate(item.date)}
              </Text>
            </View>
            <Text
              style={[
                styles.txAmount,
                { color: item.amount > 0 ? colors.pos : item.amount < 0 ? colors.neg : colors.foreground },
              ]}
            >
              {formatCurrency(item.amount, item.currency)}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator
              style={{ marginTop: 24 }}
              size="large"
              color={colors.primary}
            />
          ) : error ? (
            <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
          ) : (
            <Text style={[styles.empty, { color: colors.mutedForeground }]}>
              No transactions for this account
            </Text>
          )
        }
        ListFooterComponent={
          <View style={[styles.manageCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.manageTitle, { color: colors.foreground }]}>Manage account</Text>
            {!detail ? (
              <ActivityIndicator style={{ marginTop: 12 }} size="small" color={colors.primary} />
            ) : (
              <>
                {/* Reconciliation mode — non-investment accounts only (the card
                    lenses refuse investment accounts server-side). */}
                {!account.isInvestment && (
                  <View style={styles.modeBlock}>
                    <Text style={[styles.manageLabel, { color: colors.mutedForeground }]}>
                      Reconciliation mode
                    </Text>
                    <ModePicker accountId={detail.id} initialMode={detail.mode} />
                  </View>
                )}

                <TouchableOpacity
                  style={[styles.manageBtn, { borderColor: colors.border }]}
                  onPress={handleEdit}
                  disabled={working}
                >
                  <Icon name="edit" size={16} color={colors.foreground} />
                  <Text style={[styles.manageBtnText, { color: colors.foreground }]}>Edit account</Text>
                </TouchableOpacity>

                {detail.archived ? (
                  <Text style={[styles.archivedNote, { color: colors.mutedForeground }]}>
                    This account is archived. Unarchive it on the web app.
                  </Text>
                ) : (
                  <TouchableOpacity
                    style={[styles.manageBtn, { borderColor: colors.border }]}
                    onPress={handleArchive}
                    disabled={working}
                  >
                    <Text style={[styles.manageBtnText, { color: colors.foreground }]}>
                      Archive account
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={[styles.manageBtn, { borderColor: colors.destructive }]}
                  onPress={handleDelete}
                  disabled={working}
                >
                  <Icon name="trash" size={16} color={colors.destructive} />
                  <Text style={[styles.manageBtnText, { color: colors.destructive }]}>
                    Delete account
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        }
      />
    </SafeAreaView>
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
  backBtn: { flexDirection: "row", alignItems: "center", gap: 2 },
  backText: { fontSize: 15, fontWeight: "600" },
  addBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  addBtnText: { fontSize: 13, fontWeight: "700" },
  list: { padding: 16, paddingBottom: 32 },
  hero: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginBottom: 8,
  },
  accountName: { fontSize: 18, fontWeight: "700" },
  accountMeta: { fontSize: 13, marginTop: 4 },
  heroValue: { fontSize: 32, fontWeight: "800", marginTop: 12, fontVariant: ["tabular-nums"] },
  holdingsHint: { fontSize: 12, marginTop: 4 },
  reconcileBtn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 14,
  },
  reconcileText: { fontSize: 13, fontWeight: "600" },
  activityLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginTop: 16 },
  txRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  txLeft: { flex: 1, marginRight: 12 },
  txPayee: { fontSize: 15, fontWeight: "500" },
  txDate: { fontSize: 12, marginTop: 2 },
  txAmount: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  empty: { textAlign: "center", paddingVertical: 32, fontSize: 14 },
  manageCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginTop: 16,
  },
  manageTitle: { fontSize: 15, fontWeight: "700", marginBottom: 12 },
  manageLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  modeBlock: { marginBottom: 16 },
  manageBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 46,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 8,
  },
  manageBtnText: { fontSize: 15, fontWeight: "600" },
  archivedNote: { fontSize: 13, marginTop: 10, lineHeight: 18 },
});
