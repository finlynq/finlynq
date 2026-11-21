"use client";

/**
 * Subscriptions — ONE page for recurring payments (2026-10).
 *
 * Merges the old dev-mode-only Subscriptions list and Bill Calendar pages:
 *   - List view: tracked subscriptions grouped by status, plus recurring
 *     payments detected in the user's transactions that aren't tracked yet
 *     (one-click "Track").
 *   - Calendar view: every projected payment for a month — tracked
 *     subscriptions, untracked detected bills and expected income.
 * Both views read the same pure builders (lib/subscriptions/calendar-events.ts)
 * and schedule math (lib/subscriptions/schedule.ts), so a total in one view
 * can't disagree with the other. `/calendar` redirects to `?view=calendar`.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { PageSkeleton } from "@/components/page-skeleton";
import { useDisplayCurrency } from "@/components/currency-provider";
import { formatCurrency, formatDate } from "@/lib/currency";
import { parseSaveError } from "@/lib/save-error";
import { localDateISO } from "@/lib/utils/date";
import {
  FREQUENCY_LABELS,
  FREQUENCY_SUFFIX,
  addDays,
  daysBetween,
  frequencyOrMonthly,
  monthlyEquivalent,
  rollForwardNextDate,
} from "@/lib/subscriptions/schedule";
import {
  detectedSuggestions,
  effectiveNextDate,
  subDisplayAmount,
  subscriptionTotals,
  type RecurringRow,
} from "@/lib/subscriptions/calendar-events";
import { SubscriptionDialog, EMPTY_DRAFT, type SubscriptionDraft } from "./_components/subscription-dialog";
import { SubscriptionsCalendar } from "./_components/subscriptions-calendar";
import type { Subscription } from "./_components/types";
import {
  Bell,
  BellOff,
  CalendarClock,
  CalendarDays,
  CreditCard,
  EyeOff,
  List,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Wallet,
  XCircle,
} from "lucide-react";

type Option = { id: number; name: string | null };
type SortField = "nextDate" | "name" | "cost";
type View = "list" | "calendar";

const SUGGESTIONS_PREVIEW = 3;
const DUE_SOON_DAYS = 30;

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  paused: {
    label: "Paused",
    className: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900/60",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-900/60",
  },
};

/** "today" / "tomorrow" / "in 5 days" for near dates, else null. */
function relativeDue(date: string, today: string): string | null {
  const d = daysBetween(today, date);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d > 1 && d <= 14) return `in ${d} days`;
  return null;
}

export default function SubscriptionsPage() {
  return (
    <Suspense fallback={<PageSkeleton variant="list" rows={5} />}>
      <SubscriptionsPageContent />
    </Suspense>
  );
}

function SubscriptionsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const view: View = searchParams.get("view") === "calendar" ? "calendar" : "list";
  const { displayCurrency: ctxCurrency } = useDisplayCurrency();

  const [subs, setSubs] = useState<Subscription[]>([]);
  const [recurring, setRecurring] = useState<RecurringRow[]>([]);
  const [categories, setCategories] = useState<Option[]>([]);
  const [accounts, setAccounts] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [initialDraft, setInitialDraft] = useState<SubscriptionDraft>(EMPTY_DRAFT);

  const [sortField, setSortField] = useState<SortField>("nextDate");
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  // GH #428 — "Not a subscription": payees the user dismissed (server-side,
  // so the phone and the calendar stop suggesting them too).
  const [dismissals, setDismissals] = useState<{ id: number; payee: string | null }[]>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissAllOpen, setDismissAllOpen] = useState(false);
  const [deleteDismiss, setDeleteDismiss] = useState(false);

  const today = localDateISO();

  const loadSubs = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/subscriptions");
      if (!res.ok) throw new Error("load failed");
      const data = await res.json();
      setSubs(Array.isArray(data) ? data : []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Detection is a nice-to-have on top of the tracked list: a failure here
  // just means no suggestions / no projected income, never a page error.
  const loadRecurring = useCallback(async () => {
    try {
      const res = await fetch("/api/recurring");
      if (!res.ok) return;
      const data = await res.json();
      setRecurring(Array.isArray(data?.recurring) ? data.recurring : []);
    } catch {
      /* non-fatal */
    }
  }, []);

  const loadDismissals = useCallback(async () => {
    try {
      const res = await fetch("/api/subscriptions/dismissals");
      if (!res.ok) return;
      const json = await res.json();
      const list = json?.data?.dismissals;
      setDismissals(Array.isArray(list) ? list : []);
    } catch {
      /* non-fatal: the list just stays as it was */
    }
  }, []);

  useEffect(() => {
    loadSubs();
    loadRecurring();
    loadDismissals();
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setCategories(Array.isArray(data) ? data : []))
      .catch(() => {});
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setAccounts(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [loadSubs, loadRecurring, loadDismissals]);

  function setView(next: View) {
    router.replace(next === "calendar" ? "/subscriptions?view=calendar" : "/subscriptions", { scroll: false });
  }

  // Totals are in the currency the server converted into (FINLYNQ-123).
  const displayCurrency = subs.find((s) => s.displayCurrency)?.displayCurrency ?? ctxCurrency;
  const totals = useMemo(
    () => subscriptionTotals(subs, today, addDays(today, DUE_SOON_DAYS)),
    [subs, today],
  );
  const suggestions = useMemo(() => detectedSuggestions(recurring, subs), [recurring, subs]);

  const sorted = useMemo(() => {
    const monthlyCost = (s: Subscription) => monthlyEquivalent(Math.abs(subDisplayAmount(s)), s.frequency);
    return [...subs].sort((a, b) => {
      if (sortField === "cost") return monthlyCost(b) - monthlyCost(a);
      if (sortField === "nextDate") {
        const an = effectiveNextDate(a, today) ?? "9999-12-31";
        const bn = effectiveNextDate(b, today) ?? "9999-12-31";
        if (an !== bn) return an.localeCompare(bn);
      }
      return (a.name ?? "").localeCompare(b.name ?? "");
    });
  }, [subs, sortField, today]);

  const groups: { key: string; title: string; icon: React.ReactNode; rows: Subscription[] }[] = [
    { key: "active", title: "Active", icon: <Play className="h-4 w-4 text-emerald-500" />, rows: sorted.filter((s) => s.status === "active") },
    { key: "paused", title: "Paused", icon: <Pause className="h-4 w-4 text-amber-500" />, rows: sorted.filter((s) => s.status === "paused") },
    { key: "cancelled", title: "Cancelled", icon: <XCircle className="h-4 w-4 text-rose-500" />, rows: sorted.filter((s) => s.status === "cancelled") },
  ];

  // ── dialog openers ─────────────────────────────────────────────────────────
  function openAdd() {
    setEditing(null);
    setInitialDraft(EMPTY_DRAFT);
    setDialogOpen(true);
  }

  function openEdit(sub: Subscription) {
    setEditing(sub);
    setDialogOpen(true);
  }

  function openEditById(id: number) {
    const sub = subs.find((s) => s.id === id);
    if (sub) openEdit(sub);
  }

  function draftFromDetected(r: RecurringRow): SubscriptionDraft {
    const frequency = frequencyOrMonthly(r.frequency);
    return {
      ...EMPTY_DRAFT,
      name: r.payee,
      amount: String(Math.abs(r.avgAmount)),
      currency: r.currency,
      frequency,
      nextDate: rollForwardNextDate(r.nextDate, frequency, today) ?? "",
      accountId: r.accountId ? String(r.accountId) : "",
      categoryId: r.categoryId ? String(r.categoryId) : "",
    };
  }

  function reviewDetected(r: RecurringRow) {
    setEditing(null);
    setInitialDraft(draftFromDetected(r));
    setDialogOpen(true);
  }

  // ── mutations (each: in-flight guard, try/catch, res.ok) ───────────────────
  async function mutate(key: string, run: () => Promise<Response>, fallback: string): Promise<boolean> {
    if (busyKey) return false;
    setBusyKey(key);
    setActionError("");
    try {
      const res = await run();
      if (!res.ok) {
        setActionError(await parseSaveError(res, fallback));
        return false;
      }
      await loadSubs();
      return true;
    } catch {
      setActionError("Network error. Please try again.");
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  const putSub = (body: Record<string, unknown>) =>
    fetch("/api/subscriptions", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  function trackDetected(r: RecurringRow) {
    const d = draftFromDetected(r);
    return mutate(
      `track:${r.payee}|${r.currency}`,
      () =>
        fetch("/api/subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: d.name,
            amount: Math.abs(r.avgAmount),
            // Carry the detected native currency (feedback #7).
            currency: r.currency,
            frequency: d.frequency,
            nextDate: d.nextDate || null,
            accountId: r.accountId || null,
            categoryId: r.categoryId || null,
          }),
        }),
      `Couldn't add ${r.payee}`,
    );
  }

  /** Mark payees "Not a subscription", then reload what depends on it. */
  async function dismissPayees(payees: string[], key: string) {
    const ok = await mutate(
      key,
      () =>
        fetch("/api/subscriptions/dismissals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payees }),
        }),
      "Couldn't dismiss the suggestion",
    );
    if (ok) await Promise.all([loadRecurring(), loadDismissals()]);
    return ok;
  }

  async function undoDismissal(id: number) {
    const ok = await mutate(
      `undismiss:${id}`,
      () =>
        fetch("/api/subscriptions/dismissals", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [id] }),
        }),
      "Couldn't bring the suggestion back",
    );
    if (ok) await Promise.all([loadRecurring(), loadDismissals()]);
  }

  async function dismissAllSuggestions() {
    const ok = await dismissPayees([...new Set(suggestions.map((r) => r.payee))], "dismiss:all");
    if (ok) setDismissAllOpen(false);
  }

  function changeStatus(sub: Subscription, status: string) {
    return mutate(`status:${sub.id}`, () => putSub({ id: sub.id, status }), "Couldn't update the subscription");
  }

  function toggleReminder(sub: Subscription) {
    let cancelReminderDate: string | null = null;
    if (!sub.cancelReminderDate) {
      // Default: a week before the next payment (or a week from today).
      const next = effectiveNextDate(sub, today);
      const candidate = next ? addDays(next, -7) : addDays(today, 7);
      cancelReminderDate = candidate < today ? today : candidate;
    }
    return mutate(`reminder:${sub.id}`, () => putSub({ id: sub.id, cancelReminderDate }), "Couldn't update the reminder");
  }

  async function handleDelete() {
    if (deleteId == null) return;
    setDeleting(true);
    const name = subs.find((s) => s.id === deleteId)?.name ?? "";
    const ok = await mutate(`delete:${deleteId}`, () => fetch(`/api/subscriptions?id=${deleteId}`, { method: "DELETE" }), "Couldn't delete the subscription");
    // GH #428 — "Delete and don't suggest again": without it, deleting a
    // tracked payee brings its suggestion back on the next load.
    if (ok && deleteDismiss && name) await dismissPayees([name], `dismiss:${deleteId}`);
    setDeleting(false);
    if (ok) {
      setDeleteId(null);
      setDeleteDismiss(false);
    }
  }

  const deletingSub = subs.find((s) => s.id === deleteId) ?? null;

  if (loading) return <PageSkeleton variant="list" rows={5} />;
  if (loadError) {
    return (
      <ErrorState
        title="Couldn't load subscriptions"
        message="We couldn't load your subscriptions. Please try again."
        onRetry={() => { setLoading(true); loadSubs(); loadRecurring(); }}
      />
    );
  }

  const visibleSuggestions = showAllSuggestions ? suggestions : suggestions.slice(0, SUGGESTIONS_PREVIEW);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Subscriptions</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Recurring bills and subscriptions: what they cost and when they&apos;re due.
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="h-4 w-4 mr-1" /> Add subscription
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={<Wallet className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />}
          label="Per month"
          value={formatCurrency(totals.monthly, displayCurrency)}
        />
        <StatCard
          icon={<CalendarDays className="h-4 w-4 text-rose-600 dark:text-rose-400" />}
          label="Per year"
          value={formatCurrency(totals.annual, displayCurrency)}
        />
        <StatCard
          icon={<CalendarClock className="h-4 w-4 text-amber-600 dark:text-amber-400" />}
          label={`Due in next ${DUE_SOON_DAYS} days`}
          value={formatCurrency(totals.dueSoonAmount, displayCurrency)}
          sub={`${totals.dueSoonCount} payment${totals.dueSoonCount === 1 ? "" : "s"}`}
        />
        <StatCard
          icon={<CreditCard className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
          label="Active"
          value={String(totals.activeCount)}
          sub={`of ${subs.length} tracked`}
        />
      </div>

      {actionError && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      )}

      {/* View switch + sort */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={view} onValueChange={(v) => setView((v as View) ?? "list")}>
          <TabsList>
            <TabsTrigger value="list" className="px-3"><List className="h-4 w-4" /> List</TabsTrigger>
            <TabsTrigger value="calendar" className="px-3"><CalendarDays className="h-4 w-4" /> Calendar</TabsTrigger>
          </TabsList>
        </Tabs>
        {view === "list" && subs.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Sort by</span>
            <Select value={sortField} onValueChange={(v) => setSortField((v as SortField) ?? "nextDate")}>
              <SelectTrigger className="w-40">
                <SelectValue>{(v: unknown) => (v === "name" ? "Name" : v === "cost" ? "Monthly cost" : "Next payment")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nextDate">Next payment</SelectItem>
                <SelectItem value="cost">Monthly cost</SelectItem>
                <SelectItem value="name">Name</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {view === "calendar" ? (
        <SubscriptionsCalendar
          subs={subs}
          recurring={recurring}
          displayCurrency={displayCurrency}
          onEdit={openEditById}
          onTrack={trackDetected}
        />
      ) : (
        <div className="space-y-6">
          {/* Detected from transactions */}
          {suggestions.length > 0 && (
            <Card className="border-primary/30 bg-primary/[0.03]">
              <CardContent className="pt-5 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15">
                    <Sparkles className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <h2 className="font-semibold">Found in your transactions</h2>
                    <p className="text-sm text-muted-foreground">
                      {suggestions.length === 1
                        ? "1 payment repeats on a schedule but isn't tracked yet."
                        : `${suggestions.length} payments repeat on a schedule but aren't tracked yet.`}
                    </p>
                  </div>
                </div>
                <div className="divide-y rounded-lg border bg-background">
                  {visibleSuggestions.map((r) => {
                    const key = `track:${r.payee}|${r.currency}`;
                    const freq = frequencyOrMonthly(r.frequency);
                    return (
                      <div key={`${r.payee}|${r.currency}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{r.payee}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatCurrency(Math.abs(r.avgAmount), r.currency)} / {FREQUENCY_SUFFIX[freq]} · seen {r.count}× · last {formatDate(r.lastDate)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => dismissPayees([r.payee], `dismiss:${r.payee}`)}
                            disabled={busyKey !== null}
                            title="Not a subscription: stop suggesting this payee"
                          >
                            <EyeOff className="h-3.5 w-3.5 mr-1" />
                            {busyKey === `dismiss:${r.payee}` ? "Hiding…" : "Not a subscription"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => reviewDetected(r)}>Review</Button>
                          <Button size="sm" onClick={() => trackDetected(r)} disabled={busyKey !== null}>
                            <Plus className="h-3.5 w-3.5 mr-1" />
                            {busyKey === key ? "Adding…" : "Track"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {suggestions.length > SUGGESTIONS_PREVIEW ? (
                    <Button variant="link" size="sm" className="px-0" onClick={() => setShowAllSuggestions((v) => !v)}>
                      {showAllSuggestions ? "Show fewer" : `Show all ${suggestions.length}`}
                    </Button>
                  ) : <span />}
                  {suggestions.length > 1 && (
                    <Button variant="link" size="sm" className="px-0 text-muted-foreground" onClick={() => setDismissAllOpen(true)} disabled={busyKey !== null}>
                      None of these are subscriptions
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Dismissed suggestions (GH #428), with undo */}
          {dismissals.length > 0 && (
            <div className="text-sm">
              <Button variant="link" size="sm" className="px-0 text-muted-foreground" onClick={() => setShowDismissed((v) => !v)}>
                {showDismissed ? "Hide" : "Show"} dismissed suggestions ({dismissals.length})
              </Button>
              {showDismissed && (
                <div className="mt-1 divide-y rounded-lg border bg-background">
                  {dismissals.map((d) => (
                    <div key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="truncate">{d.payee ?? "(can't be read with your current sign-in)"}</span>
                      <Button variant="ghost" size="sm" onClick={() => undoDismissal(d.id)} disabled={busyKey !== null}>
                        <RotateCcw className="h-3.5 w-3.5 mr-1" />
                        {busyKey === `undismiss:${d.id}` ? "Restoring…" : "Suggest again"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {subs.length === 0 && (
            <Card>
              <CardContent className="py-12 flex flex-col items-center text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted mb-4">
                  <CreditCard className="h-7 w-7 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold mb-1">No subscriptions tracked yet</h3>
                <p className="text-sm text-muted-foreground max-w-sm mb-4">
                  Add streaming services, insurance, memberships and other repeating bills (weekly to annual)
                  to see what they cost you and when each one is due.
                </p>
                <Button onClick={openAdd}>
                  <Plus className="h-4 w-4 mr-1" /> Add subscription
                </Button>
              </CardContent>
            </Card>
          )}

          {groups.map((g) =>
            g.rows.length === 0 ? null : (
              <section key={g.key} className="space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-2 uppercase tracking-wide">
                  {g.icon}
                  {g.title} ({g.rows.length})
                </h2>
                <div className="space-y-2">
                  {g.rows.map((sub) => (
                    <SubscriptionRowCard
                      key={sub.id}
                      sub={sub}
                      today={today}
                      displayCurrency={displayCurrency}
                      busy={busyKey !== null}
                      onEdit={() => openEdit(sub)}
                      onStatus={(s) => changeStatus(sub, s)}
                      onToggleReminder={() => toggleReminder(sub)}
                      onDelete={() => setDeleteId(sub.id)}
                    />
                  ))}
                </div>
              </section>
            ),
          )}
        </div>
      )}

      <SubscriptionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        initial={initialDraft}
        categories={categories}
        accounts={accounts}
        onSaved={() => { loadSubs(); }}
      />

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => { if (!open && !deleting) setDeleteId(null); }}
        title="Delete subscription"
        description={
          <>
            Delete <strong>{deletingSub?.name ?? "this subscription"}</strong>? Your transactions are not affected. This cannot be undone.
            <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={deleteDismiss}
                onChange={(e) => setDeleteDismiss(e.target.checked)}
              />
              Don&apos;t suggest this payee again
            </label>
          </>
        }
        confirmLabel="Delete subscription"
        busy={deleting}
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={dismissAllOpen}
        onOpenChange={(open) => { if (!open && busyKey !== "dismiss:all") setDismissAllOpen(false); }}
        title="Dismiss all suggestions"
        description={<>Stop suggesting these {suggestions.length} payees as subscriptions? You can bring any of them back from the dismissed list.</>}
        confirmLabel="Dismiss all"
        busy={busyKey === "dismiss:all"}
        onConfirm={dismissAllSuggestions}
      />
    </div>
  );
}

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          <span className="truncate">{label}</span>
        </div>
        <p className="text-xl sm:text-2xl font-bold mt-1 tabular-nums truncate">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function SubscriptionRowCard({
  sub,
  today,
  displayCurrency,
  busy,
  onEdit,
  onStatus,
  onToggleReminder,
  onDelete,
}: {
  sub: Subscription;
  today: string;
  displayCurrency: string;
  busy: boolean;
  onEdit: () => void;
  onStatus: (status: string) => void;
  onToggleReminder: () => void;
  onDelete: () => void;
}) {
  const freq = frequencyOrMonthly(sub.frequency);
  const next = effectiveNextDate(sub, today);
  const rel = next && sub.status === "active" ? relativeDue(next, today) : null;
  const monthly = monthlyEquivalent(Math.abs(subDisplayAmount(sub)), freq);
  const showMonthly = freq !== "monthly" || sub.currency !== displayCurrency;
  const statusBadge = STATUS_BADGE[sub.status];
  const initial = (sub.name ?? "?").trim().charAt(0).toUpperCase() || "?";

  const meta = [
    FREQUENCY_LABELS[freq],
    sub.status === "active" ? (next ? `next ${formatDate(next)}${rel ? ` (${rel})` : ""}` : "no date set") : null,
    sub.categoryName,
  ].filter(Boolean).join(" · ");

  return (
    <Card
      className={`cursor-pointer transition-colors hover:bg-muted/30 ${sub.status !== "active" ? "opacity-75" : ""}`}
      onClick={onEdit}
    >
      <CardContent className="py-3 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="font-semibold truncate">{sub.name ?? "Subscription"}</h3>
            {statusBadge && <Badge className={statusBadge.className}>{statusBadge.label}</Badge>}
            {rel === "today" || rel === "tomorrow" ? (
              <Badge className="bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900/60">
                Due {rel}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{meta}</p>
          {sub.cancelReminderDate && (
            <p className="text-xs text-orange-600 dark:text-orange-400 mt-0.5 flex items-center gap-1">
              <Bell className="h-3 w-3" /> Cancel reminder {formatDate(sub.cancelReminderDate)}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="font-semibold tabular-nums">
            {formatCurrency(sub.amount, sub.currency)}
            <span className="text-xs font-normal text-muted-foreground"> / {FREQUENCY_SUFFIX[freq]}</span>
          </p>
          {showMonthly && (
            <p className="text-xs text-muted-foreground tabular-nums">≈ {formatCurrency(monthly, displayCurrency)} / mo</p>
          )}
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${sub.name ?? "subscription"}`} disabled={busy}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onClick={onEdit}><Pencil /> Edit</DropdownMenuItem>
              {sub.status === "active" && (
                <>
                  <DropdownMenuItem onClick={onToggleReminder}>
                    {sub.cancelReminderDate ? <><BellOff /> Remove cancel reminder</> : <><Bell /> Remind me to cancel</>}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onStatus("paused")}><Pause /> Pause</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onStatus("cancelled")}><XCircle /> Mark cancelled</DropdownMenuItem>
                </>
              )}
              {sub.status === "paused" && (
                <DropdownMenuItem onClick={() => onStatus("active")}><Play /> Resume</DropdownMenuItem>
              )}
              {sub.status === "cancelled" && (
                <DropdownMenuItem onClick={() => onStatus("active")}><RotateCcw /> Reactivate</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2 /> Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}
