// Subscriptions — tracked recurring bills plus the ones detected in the user's
// transactions, as a List or a month Calendar. Mirrors the web /subscriptions
// page (merged Subscriptions + Bill Calendar, 2026-10). All schedule / total /
// suggestion math comes from ../lib/subscriptions (a mirror of the web
// lib/subscriptions/*), so the app and the web agree on what is due when.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTheme } from "../theme";
import { endpoints } from "../api/client";
import { logger } from "../lib/logger";
import { formatCurrency, formatShortDate, initial, safeName } from "../lib/format";
import { Icon } from "../components/icon";
import {
  FREQUENCY_LABELS,
  FREQUENCY_SUFFIX,
  addDays,
  buildScheduleEvents,
  daysBetween,
  detectedSuggestions,
  effectiveNextDate,
  frequencyOrMonthly,
  localDateISO,
  monthlyEquivalent,
  rollForwardNextDate,
  subDisplayAmount,
  subscriptionTotals,
  type ScheduleEvent,
} from "../lib/subscriptions";
import type { RecurringItem, Subscription, SubscriptionFormData } from "../../../shared/types";
import type { MoreStackParamList } from "../navigation/MoreStack";

type Nav = NativeStackNavigationProp<MoreStackParamList, "Subscriptions">;
type View_ = "list" | "calendar";

const DUE_SOON_DAYS = 30;
const SUGGESTIONS_PREVIEW = 3;
const DAY_NAMES = ["S", "M", "T", "W", "T", "F", "S"];
const pad = (n: number) => String(n).padStart(2, "0");

function relativeDue(date: string, today: string): string | null {
  const d = daysBetween(today, date);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d > 1 && d <= 14) return `in ${d} days`;
  return null;
}

/** Track payload for a detected series. Empty optionals are OMITTED (not
 *  nulled) so a server older than the 2026-10 merge still accepts it. */
export function trackPayload(r: RecurringItem, today: string): SubscriptionFormData {
  const frequency = frequencyOrMonthly(r.frequency);
  const nextDate = rollForwardNextDate(r.nextDate, frequency, today);
  return {
    name: r.payee,
    amount: Math.abs(r.avgAmount),
    currency: r.currency,
    frequency,
    ...(nextDate ? { nextDate } : {}),
    ...(r.accountId ? { accountId: r.accountId } : {}),
    ...(r.categoryId ? { categoryId: r.categoryId } : {}),
  };
}

export default function SubscriptionsScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();
  const isFocused = useIsFocused();

  const [subs, setSubs] = useState<Subscription[]>([]);
  const [recurring, setRecurring] = useState<RecurringItem[]>([]);
  const [fallbackCurrency, setFallbackCurrency] = useState("USD");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View_>("list");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);

  const today = localDateISO();
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));
  const [month, setMonth] = useState(() => Number(today.slice(5, 7)) - 1);
  const [selectedDay, setSelectedDay] = useState<number | null>(() => Number(today.slice(8, 10)));

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [subsRes, recRes] = await Promise.all([endpoints.getSubscriptions(), endpoints.getRecurring()]);
      if (subsRes.success) {
        setSubs(Array.isArray(subsRes.data) ? subsRes.data : []);
        setError(null);
      } else {
        logger.warn("subscriptions", "fetch failed", { error: subsRes.error });
        // Servers older than the 2026-10 merge dev-mode-gate this route (404).
        setError(
          subsRes.error === "Not found"
            ? "Subscriptions need a newer Finlynq server. Update your server, or use the web app."
            : subsRes.error,
        );
      }
      // Detection is a nice-to-have: a failure just means no suggestions.
      if (recRes.success) {
        setRecurring(Array.isArray(recRes.data?.recurring) ? recRes.data.recurring : []);
        if (recRes.data?.displayCurrency) setFallbackCurrency(recRes.data.displayCurrency);
      }
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("subscriptions", "fetch threw", { detail });
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (isFocused) load();
  }, [isFocused, load]);

  const displayCurrency = subs.find((s) => s.displayCurrency)?.displayCurrency ?? fallbackCurrency;
  const totals = useMemo(() => subscriptionTotals(subs, today, addDays(today, DUE_SOON_DAYS)), [subs, today]);
  const suggestions = useMemo(() => detectedSuggestions(recurring, subs), [recurring, subs]);

  const sorted = useMemo(
    () =>
      [...subs].sort((a, b) => {
        const an = effectiveNextDate(a, today) ?? "9999-12-31";
        const bn = effectiveNextDate(b, today) ?? "9999-12-31";
        return an !== bn ? an.localeCompare(bn) : (a.name ?? "").localeCompare(b.name ?? "");
      }),
    [subs, today],
  );

  // ── mutations ──────────────────────────────────────────────────────────────
  const runAction = async (key: string, fn: () => Promise<{ success: boolean; error?: string }>, failTitle: string) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      const res = await fn();
      if (!res.success) {
        logger.warn("subscriptions", "action rejected", { key, error: res.error });
        Alert.alert(failTitle, res.error || "Please try again.");
        return;
      }
      await load();
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error("subscriptions", "action threw", { key, detail });
      Alert.alert("Error", "Cannot connect to server");
    } finally {
      setBusyKey(null);
    }
  };

  const track = (r: RecurringItem) =>
    runAction(`track:${r.payee}|${r.currency}`, () => endpoints.createSubscription(trackPayload(r, today)), `Couldn't add ${r.payee}`);

  const review = (r: RecurringItem) => navigation.navigate("AddSubscription", { prefill: trackPayload(r, today) });

  const setStatus = (s: Subscription, status: Subscription["status"]) =>
    runAction(`status:${s.id}`, () => endpoints.updateSubscription({ id: s.id, status }), "Couldn't update subscription");

  const openActions = (s: Subscription) => {
    const name = safeName(s.name, "Subscription");
    // Android Alerts show at most 3 buttons — delete lives on the edit screen.
    if (s.status === "active") {
      Alert.alert(name, undefined, [
        { text: "Pause", onPress: () => setStatus(s, "paused") },
        { text: "Mark cancelled", style: "destructive", onPress: () => setStatus(s, "cancelled") },
        { text: "Close", style: "cancel" },
      ]);
    } else {
      Alert.alert(name, undefined, [
        { text: s.status === "paused" ? "Resume" : "Reactivate", onPress: () => setStatus(s, "active") },
        { text: "Close", style: "cancel" },
      ]);
    }
  };

  // ── calendar data ──────────────────────────────────────────────────────────
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const monthStart = `${year}-${pad(month + 1)}-01`;
  const monthEnd = `${year}-${pad(month + 1)}-${pad(daysInMonth)}`;
  const events = useMemo(
    () => buildScheduleEvents(subs, recurring, monthStart, monthEnd),
    [subs, recurring, monthStart, monthEnd],
  );
  const eventsByDay = useMemo(() => {
    const map = new Map<number, ScheduleEvent[]>();
    for (const ev of events) {
      const d = Number(ev.date.slice(8, 10));
      map.set(d, [...(map.get(d) ?? []), ev]);
    }
    return map;
  }, [events]);
  const monthBills = events.filter((e) => e.type === "bill").reduce((s, e) => s + e.displayAmount, 0);
  const monthIncome = events.filter((e) => e.type === "income").reduce((s, e) => s + e.displayAmount, 0);
  const isCurrentMonth = today.slice(0, 7) === monthStart.slice(0, 7);
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-CA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const shiftMonth = (delta: number) => {
    const total = year * 12 + month + delta;
    setYear(Math.floor(total / 12));
    setMonth(((total % 12) + 12) % 12);
    setSelectedDay(null);
  };

  const eventColor = (ev: Pick<ScheduleEvent, "type" | "source">) =>
    ev.type === "income" ? colors.pos : ev.source === "subscription" ? colors.primary : colors.neg;

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // ── render helpers ─────────────────────────────────────────────────────────
  const renderSubRow = (s: Subscription, last: boolean) => {
    const freq = frequencyOrMonthly(s.frequency);
    const next = effectiveNextDate(s, today);
    const rel = next && s.status === "active" ? relativeDue(next, today) : null;
    const monthly = monthlyEquivalent(Math.abs(subDisplayAmount(s)), freq);
    const showMonthly = freq !== "monthly" || s.currency !== displayCurrency;
    const meta = [
      FREQUENCY_LABELS[freq],
      s.status === "active" ? (next ? `next ${formatShortDate(next)}${rel ? ` (${rel})` : ""}` : "no date set") : null,
      s.categoryName ?? null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <TouchableOpacity
        key={s.id}
        activeOpacity={0.7}
        onPress={() => navigation.navigate("AddSubscription", { subscription: s })}
        onLongPress={() => openActions(s)}
        accessibilityHint="Long-press for pause and cancel"
        style={[
          styles.row,
          !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
          s.status !== "active" && { opacity: 0.65 },
        ]}
      >
        <View style={[styles.avatar, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.avatarText, { color: colors.mutedForeground }]}>{initial(s.name)}</Text>
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.rowName, { color: colors.foreground }]} numberOfLines={1}>
            {safeName(s.name, "Subscription")}
          </Text>
          <Text style={[styles.rowMeta, { color: rel === "today" || rel === "tomorrow" ? colors.primary : colors.mutedForeground }]} numberOfLines={1}>
            {meta}
          </Text>
          {s.cancelReminderDate ? (
            <Text style={[styles.rowMeta, { color: colors.primary }]} numberOfLines={1}>
              Cancel reminder {formatShortDate(s.cancelReminderDate)}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowAmount}>
          <Text style={[styles.amount, { color: colors.foreground }]}>
            {formatCurrency(s.amount, s.currency)}
            <Text style={[styles.amountSuffix, { color: colors.mutedForeground }]}> /{FREQUENCY_SUFFIX[freq]}</Text>
          </Text>
          {showMonthly && (
            <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
              ≈ {formatCurrency(monthly, displayCurrency)}/mo
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const groups: { key: string; title: string; rows: Subscription[] }[] = [
    { key: "active", title: "Active", rows: sorted.filter((s) => s.status === "active") },
    { key: "paused", title: "Paused", rows: sorted.filter((s) => s.status === "paused") },
    { key: "cancelled", title: "Cancelled", rows: sorted.filter((s) => s.status === "cancelled") },
  ];

  const visibleSuggestions = showAllSuggestions ? suggestions : suggestions.slice(0, SUGGESTIONS_PREVIEW);
  const selectedEvents = selectedDay ? eventsByDay.get(selectedDay) ?? [] : [];

  const listView = (
    <>
      {suggestions.length > 0 && (
        <View style={[styles.card, styles.suggestCard, { backgroundColor: colors.card, borderColor: colors.primary }]}>
          <View style={styles.suggestHead}>
            <View style={[styles.iconWrap, { backgroundColor: colors.accent }]}>
              <Icon name="sampleData" size={16} color={colors.primary} />
            </View>
            <View style={styles.rowText}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Found in your transactions</Text>
              <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                {suggestions.length === 1
                  ? "1 payment repeats but isn't tracked yet."
                  : `${suggestions.length} payments repeat but aren't tracked yet.`}
              </Text>
            </View>
          </View>
          {visibleSuggestions.map((r) => {
            const freq = frequencyOrMonthly(r.frequency);
            const key = `track:${r.payee}|${r.currency}`;
            return (
              <View key={`${r.payee}|${r.currency}`} style={[styles.suggestRow, { borderTopColor: colors.border }]}>
                <View style={styles.rowText}>
                  <Text style={[styles.rowName, { color: colors.foreground }]} numberOfLines={1}>{r.payee}</Text>
                  <Text style={[styles.rowMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {formatCurrency(Math.abs(r.avgAmount), r.currency)} /{FREQUENCY_SUFFIX[freq]} · seen {r.count}×
                  </Text>
                </View>
                <TouchableOpacity onPress={() => review(r)} style={styles.ghostBtn} hitSlop={6}>
                  <Text style={[styles.ghostBtnText, { color: colors.mutedForeground }]}>Review</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => track(r)}
                  disabled={busyKey !== null}
                  style={[styles.smallBtn, { backgroundColor: colors.primary, opacity: busyKey && busyKey !== key ? 0.5 : 1 }]}
                >
                  {busyKey === key ? (
                    <ActivityIndicator size="small" color={colors.primaryForeground} />
                  ) : (
                    <Text style={[styles.smallBtnText, { color: colors.primaryForeground }]}>Track</Text>
                  )}
                </TouchableOpacity>
              </View>
            );
          })}
          {suggestions.length > SUGGESTIONS_PREVIEW && (
            <TouchableOpacity onPress={() => setShowAllSuggestions((v) => !v)} style={styles.showAll}>
              <Text style={[styles.ghostBtnText, { color: colors.primary }]}>
                {showAllSuggestions ? "Show fewer" : `Show all ${suggestions.length}`}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {subs.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            No subscriptions tracked yet. Add streaming, insurance, memberships and other repeating bills — weekly to annual.
          </Text>
          <TouchableOpacity
            style={[styles.ctaBtn, { backgroundColor: colors.primary }]}
            onPress={() => navigation.navigate("AddSubscription")}
          >
            <Text style={[styles.ctaBtnText, { color: colors.primaryForeground }]}>+ Add a subscription</Text>
          </TouchableOpacity>
        </View>
      ) : (
        groups.map((g) =>
          g.rows.length === 0 ? null : (
            <View key={g.key}>
              <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
                {g.title.toUpperCase()} ({g.rows.length})
              </Text>
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {g.rows.map((s, i) => renderSubRow(s, i === g.rows.length - 1))}
              </View>
            </View>
          ),
        )
      )}
      {subs.length > 0 && (
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>Tap to edit · long-press to pause or cancel</Text>
      )}
    </>
  );

  const calendarView = (
    <>
      <View style={[styles.card, styles.calCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.calHead}>
          <TouchableOpacity onPress={() => shiftMonth(-1)} hitSlop={10} accessibilityLabel="Previous month">
            <Icon name="back" size={20} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity
            disabled={isCurrentMonth}
            onPress={() => {
              setYear(Number(today.slice(0, 4)));
              setMonth(Number(today.slice(5, 7)) - 1);
              setSelectedDay(Number(today.slice(8, 10)));
            }}
          >
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>{monthLabel}</Text>
            {!isCurrentMonth && <Text style={[styles.todayLink, { color: colors.primary }]}>Back to today</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => shiftMonth(1)} hitSlop={10} accessibilityLabel="Next month">
            <Icon name="chevronRight" size={20} color={colors.foreground} />
          </TouchableOpacity>
        </View>
        <View style={styles.weekRow}>
          {DAY_NAMES.map((d, i) => (
            <Text key={i} style={[styles.weekday, { color: colors.mutedForeground }]}>{d}</Text>
          ))}
        </View>
        <View style={styles.grid}>
          {Array.from({ length: firstWeekday }, (_, i) => (
            <View key={`pad-${i}`} style={styles.cell} />
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const day = i + 1;
            const dayEvents = eventsByDay.get(day) ?? [];
            const isToday = isCurrentMonth && day === Number(today.slice(8, 10));
            const isSelected = selectedDay === day;
            return (
              <TouchableOpacity
                key={day}
                style={[styles.cell, isSelected && { backgroundColor: colors.accent, borderRadius: 10 }]}
                onPress={() => setSelectedDay(isSelected ? null : day)}
                accessibilityLabel={`${monthLabel} ${day}${dayEvents.length ? `, ${dayEvents.length} payments` : ""}`}
              >
                <View style={[styles.dayBubble, isToday && { backgroundColor: colors.primary }]}>
                  <Text style={[styles.dayText, { color: isToday ? colors.primaryForeground : colors.foreground }]}>{day}</Text>
                </View>
                <View style={styles.dots}>
                  {dayEvents.slice(0, 3).map((ev, idx) => (
                    <View key={idx} style={[styles.dot, { backgroundColor: eventColor(ev) }]} />
                  ))}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={styles.legend}>
          {[
            { label: "Subscription", color: colors.primary },
            { label: "Detected bill", color: colors.neg },
            { label: "Income", color: colors.pos },
          ].map((l) => (
            <View key={l.label} style={styles.legendItem}>
              <View style={[styles.dot, { backgroundColor: l.color }]} />
              <Text style={[styles.legendText, { color: colors.mutedForeground }]}>{l.label}</Text>
            </View>
          ))}
        </View>
      </View>

      {selectedDay !== null && (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.dayTitle, { color: colors.foreground }]}>
            {new Date(Date.UTC(year, month, selectedDay)).toLocaleDateString("en-CA", {
              weekday: "long",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}
          </Text>
          {selectedEvents.length === 0 ? (
            <Text style={[styles.rowMeta, styles.dayEmpty, { color: colors.mutedForeground }]}>Nothing expected on this day.</Text>
          ) : (
            selectedEvents.map((ev, idx) => (
              <View key={`${ev.name}-${idx}`} style={[styles.eventRow, idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
                <View style={[styles.dot, styles.eventDot, { backgroundColor: eventColor(ev) }]} />
                <View style={styles.rowText}>
                  <Text style={[styles.rowName, { color: colors.foreground }]} numberOfLines={1}>{ev.name}</Text>
                  <Text style={[styles.rowMeta, { color: colors.mutedForeground }]}>
                    {ev.source === "subscription" ? "Subscription" : ev.type === "income" ? "Expected income" : "Detected"} · {FREQUENCY_LABELS[ev.frequency]}
                  </Text>
                </View>
                <Text style={[styles.amount, { color: ev.type === "income" ? colors.pos : colors.neg }]}>
                  {ev.type === "income" ? "+" : "−"}
                  {formatCurrency(ev.amount, ev.currency)}
                </Text>
                {ev.source === "subscription" && ev.subscriptionId != null ? (
                  <TouchableOpacity
                    style={styles.ghostBtn}
                    onPress={() => {
                      const s = subs.find((x) => x.id === ev.subscriptionId);
                      if (s) navigation.navigate("AddSubscription", { subscription: s });
                    }}
                  >
                    <Text style={[styles.ghostBtnText, { color: colors.primary }]}>Edit</Text>
                  </TouchableOpacity>
                ) : ev.source === "detected" && ev.type === "bill" && ev.detected ? (
                  <TouchableOpacity style={styles.ghostBtn} onPress={() => track(ev.detected as RecurringItem)} disabled={busyKey !== null}>
                    <Text style={[styles.ghostBtnText, { color: colors.primary }]}>Track</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ))
          )}
        </View>
      )}

      <View style={styles.tiles}>
        <Tile label="Bills this month" value={formatCurrency(monthBills, displayCurrency, { decimals: 0 })} color={colors.neg} />
        <Tile label="Income this month" value={formatCurrency(monthIncome, displayCurrency, { decimals: 0 })} color={colors.pos} />
      </View>
      <Text style={[styles.hint, { color: colors.mutedForeground }]}>
        Income and untracked bills are projected from repeating transactions. Totals in {displayCurrency} at today's rates.
      </Text>
    </>
  );

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} style={styles.backBtn} accessibilityLabel="Back">
          <Icon name="back" size={20} color={colors.primary} />
        </TouchableOpacity>
        <Text style={[styles.header, { color: colors.foreground }]}>Subscriptions</Text>
        <TouchableOpacity
          style={[styles.addSmallBtn, { backgroundColor: colors.primary }]}
          onPress={() => navigation.navigate("AddSubscription")}
        >
          <Text style={[styles.addSmallBtnText, { color: colors.primaryForeground }]}>+ Add</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
      >
        {error ? (
          <Text style={[styles.empty, { color: colors.destructive }]}>{error}</Text>
        ) : (
          <>
            <View style={styles.tiles}>
              <Tile label="Per month" value={formatCurrency(totals.monthly, displayCurrency)} />
              <Tile label="Per year" value={formatCurrency(totals.annual, displayCurrency, { decimals: 0 })} />
              <Tile
                label={`Next ${DUE_SOON_DAYS} days`}
                value={formatCurrency(totals.dueSoonAmount, displayCurrency)}
                sub={`${totals.dueSoonCount} payment${totals.dueSoonCount === 1 ? "" : "s"}`}
              />
              <Tile label="Active" value={String(totals.activeCount)} sub={`of ${subs.length} tracked`} />
            </View>

            <View style={[styles.segment, { backgroundColor: colors.secondary }]}>
              {(["list", "calendar"] as View_[]).map((v) => (
                <TouchableOpacity
                  key={v}
                  onPress={() => setView(v)}
                  style={[styles.segmentBtn, view === v && { backgroundColor: colors.card }]}
                  accessibilityState={{ selected: view === v }}
                >
                  <Text style={[styles.segmentText, { color: view === v ? colors.foreground : colors.mutedForeground }]}>
                    {v === "list" ? "List" : "Calendar"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {view === "list" ? listView : calendarView}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.tileLabel, { color: colors.mutedForeground }]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.tileValue, { color: color ?? colors.foreground }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={[styles.tileSub, { color: colors.mutedForeground }]}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  backBtn: { marginRight: 8 },
  header: { flex: 1, fontSize: 26, fontWeight: "800" },
  addSmallBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  addSmallBtnText: { fontSize: 14, fontWeight: "700" },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  tiles: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", marginBottom: 4 },
  tile: {
    width: "48.5%",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  tileLabel: { fontSize: 12, fontWeight: "600" },
  tileValue: { fontSize: 19, fontWeight: "800", marginTop: 2, fontVariant: ["tabular-nums"] },
  tileSub: { fontSize: 11, marginTop: 1 },
  segment: { flexDirection: "row", borderRadius: 10, padding: 3, marginVertical: 8 },
  segmentBtn: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
  segmentText: { fontSize: 14, fontWeight: "700" },
  sectionTitle: { fontSize: 12, fontWeight: "700", letterSpacing: 0.5, marginTop: 10, marginBottom: 8 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 8, overflow: "hidden" },
  cardTitle: { fontSize: 15, fontWeight: "700", textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 12 },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", marginRight: 10 },
  avatarText: { fontSize: 15, fontWeight: "700" },
  rowText: { flex: 1, marginRight: 8 },
  rowName: { fontSize: 15, fontWeight: "600" },
  rowMeta: { fontSize: 12, marginTop: 2 },
  rowAmount: { alignItems: "flex-end" },
  amount: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  amountSuffix: { fontSize: 12, fontWeight: "500" },
  suggestCard: { padding: 12 },
  suggestHead: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  iconWrap: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", marginRight: 10 },
  suggestRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  smallBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, minWidth: 64, alignItems: "center" },
  smallBtnText: { fontSize: 13, fontWeight: "700" },
  ghostBtn: { paddingHorizontal: 8, paddingVertical: 6, marginLeft: 2 },
  ghostBtnText: { fontSize: 13, fontWeight: "700" },
  showAll: { paddingTop: 8, alignItems: "center" },
  emptyWrap: { alignItems: "center", paddingVertical: 24 },
  empty: { textAlign: "center", paddingVertical: 16, fontSize: 14, lineHeight: 20, paddingHorizontal: 12 },
  ctaBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, marginTop: 8 },
  ctaBtnText: { fontSize: 15, fontWeight: "700" },
  hint: { fontSize: 12, textAlign: "center", marginTop: 8, lineHeight: 17, paddingHorizontal: 8 },
  calCard: { padding: 10 },
  calHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4, marginBottom: 8 },
  todayLink: { fontSize: 11, fontWeight: "600", textAlign: "center", marginTop: 1 },
  weekRow: { flexDirection: "row" },
  weekday: { width: "14.2857%", textAlign: "center", fontSize: 11, fontWeight: "700", paddingBottom: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: "14.2857%", height: 50, alignItems: "center", paddingTop: 3 },
  dayBubble: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  dayText: { fontSize: 13, fontWeight: "600" },
  dots: { flexDirection: "row", marginTop: 3, height: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, marginHorizontal: 1 },
  legend: { flexDirection: "row", justifyContent: "center", flexWrap: "wrap", marginTop: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", marginHorizontal: 6 },
  legendText: { fontSize: 11, marginLeft: 4 },
  dayTitle: { fontSize: 15, fontWeight: "700", paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 },
  dayEmpty: { paddingHorizontal: 12, paddingBottom: 12 },
  eventRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10 },
  eventDot: { marginRight: 10, width: 8, height: 8, borderRadius: 4 },
});
