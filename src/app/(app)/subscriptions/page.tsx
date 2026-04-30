"use client";

import { DevModeGuard } from "@/components/dev-mode-guard";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox, type ComboboxItemShape } from "@/components/ui/combobox";
import { useDropdownOrder } from "@/components/dropdown-order-provider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate } from "@/lib/currency";
import {
  Plus,
  Trash2,
  CreditCard,
  Pause,
  Play,
  XCircle,
  Zap,
  ArrowUpDown,
  DollarSign,
  CalendarDays,
  RotateCcw,
  Bell,
  BellOff,
} from "lucide-react";

type Subscription = {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: string;
  categoryId: number | null;
  categoryName: string | null;
  accountId: number | null;
  accountName: string | null;
  nextDate: string | null;
  status: string;
  cancelReminderDate: string | null;
  notes: string | null;
};

type DetectedSub = {
  name: string;
  amount: number;
  frequency: string;
  nextDate: string;
  accountId: number;
  categoryId: number | null;
  count: number;
  lastDate: string;
};

type Category = { id: number; name: string };
type Account = { id: number; name: string };

type SortField = "name" | "amount" | "nextDate";

const frequencyLabels: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

const statusConfig: Record<
  string,
  { label: string; badgeClass: string; borderClass: string }
> = {
  active: {
    label: "Active",
    badgeClass: "bg-emerald-100 text-emerald-700 border-emerald-200",
    borderClass: "border-l-emerald-500",
  },
  paused: {
    label: "Paused",
    badgeClass: "bg-amber-100 text-amber-700 border-amber-200",
    borderClass: "border-l-amber-500",
  },
  cancelled: {
    label: "Cancelled",
    badgeClass: "bg-rose-100 text-rose-700 border-rose-200",
    borderClass: "border-l-rose-500",
  },
};

function toMonthlyAmount(amount: number, frequency: string): number {
  switch (frequency) {
    case "weekly":
      return amount * 4.33;
    case "quarterly":
      return amount / 3;
    case "annual":
      return amount / 12;
    default:
      return amount;
  }
}

function SubscriptionsPageContent() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detectDialogOpen, setDetectDialogOpen] = useState(false);
  const [detected, setDetected] = useState<DetectedSub[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [editSub, setEditSub] = useState<Subscription | null>(null);
  const [sortField, setSortField] = useState<SortField>("name");
  const [form, setForm] = useState({
    name: "",
    amount: "",
    currency: "CAD",
    frequency: "monthly",
    categoryId: "",
    accountId: "",
    nextDate: "",
    notes: "",
    cancelReminderDate: "",
  });

  const load = useCallback(() => {
    fetch("/api/subscriptions")
      .then((r) => r.json())
      .then(setSubs);
  }, []);

  useEffect(() => {
    load();
    fetch("/api/categories")
      .then((r) => r.json())
      .then(setCategories);
    fetch("/api/accounts")
      .then((r) => r.json())
      .then(setAccounts);
  }, [load]);

  const sortAccount = useDropdownOrder("account");
  const sortCategory = useDropdownOrder("category");
  const sortCurrency = useDropdownOrder("currency");

  function resetForm() {
    setForm({
      name: "",
      amount: "",
      currency: "CAD",
      frequency: "monthly",
      categoryId: "",
      accountId: "",
      nextDate: "",
      notes: "",
      cancelReminderDate: "",
    });
    setEditSub(null);
  }

  function openEdit(sub: Subscription) {
    setEditSub(sub);
    setForm({
      name: sub.name,
      amount: String(sub.amount),
      currency: sub.currency,
      frequency: sub.frequency,
      categoryId: sub.categoryId ? String(sub.categoryId) : "",
      accountId: sub.accountId ? String(sub.accountId) : "",
      nextDate: sub.nextDate ?? "",
      notes: sub.notes ?? "",
      cancelReminderDate: sub.cancelReminderDate ?? "",
    });
    setDialogOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      name: form.name,
      amount: parseFloat(form.amount),
      currency: form.currency,
      frequency: form.frequency,
      categoryId: form.categoryId ? parseInt(form.categoryId) : null,
      accountId: form.accountId ? parseInt(form.accountId) : null,
      nextDate: form.nextDate || null,
      notes: form.notes || null,
      cancelReminderDate: form.cancelReminderDate || null,
    };

    if (editSub) {
      await fetch("/api/subscriptions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editSub.id, ...payload }),
      });
    } else {
      await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    setDialogOpen(false);
    resetForm();
    load();
  }

  async function handleStatusChange(sub: Subscription, newStatus: string) {
    await fetch("/api/subscriptions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sub.id, status: newStatus }),
    });
    load();
  }

  async function handleDelete(id: number) {
    await fetch(`/api/subscriptions?id=${id}`, { method: "DELETE" });
    load();
  }

  async function handleDetect() {
    setDetecting(true);
    try {
      const res = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "detect" }),
      });
      const data = await res.json();
      setDetected(data.suggestions ?? []);
      setDetectDialogOpen(true);
    } finally {
      setDetecting(false);
    }
  }

  async function addDetected(d: DetectedSub) {
    await fetch("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: d.name,
        amount: d.amount,
        frequency: d.frequency,
        nextDate: d.nextDate,
        accountId: d.accountId || null,
        categoryId: d.categoryId || null,
      }),
    });
    setDetected((prev) => prev.filter((x) => x.name !== d.name));
    load();
  }

  async function toggleCancelReminder(sub: Subscription) {
    if (sub.cancelReminderDate) {
      // Remove reminder
      await fetch("/api/subscriptions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sub.id, cancelReminderDate: null }),
      });
    } else {
      // Set reminder to 7 days before next date, or 7 days from now
      const baseDate = sub.nextDate
        ? new Date(sub.nextDate + "T00:00:00")
        : new Date();
      baseDate.setDate(baseDate.getDate() - 7);
      const reminderDate = baseDate.toISOString().split("T")[0];
      await fetch("/api/subscriptions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sub.id, cancelReminderDate: reminderDate }),
      });
    }
    load();
  }

  // Compute summaries
  const activeSubs = subs.filter((s) => s.status === "active");
  const pausedSubs = subs.filter((s) => s.status === "paused");
  const cancelledSubs = subs.filter((s) => s.status === "cancelled");

  const totalMonthly = activeSubs.reduce(
    (sum, s) => sum + toMonthlyAmount(s.amount, s.frequency),
    0
  );
  const totalAnnual = totalMonthly * 12;

  // Sorting
  function sortSubs(list: Subscription[]): Subscription[] {
    return [...list].sort((a, b) => {
      switch (sortField) {
        case "amount":
          return b.amount - a.amount;
        case "nextDate":
          return (a.nextDate ?? "").localeCompare(b.nextDate ?? "");
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }

  function renderSubList(
    list: Subscription[],
    title: string,
    icon: React.ReactNode
  ) {
    if (list.length === 0) return null;
    const sorted = sortSubs(list);
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-muted-foreground flex items-center gap-2">
          {icon}
          {title} ({list.length})
        </h2>
        {sorted.map((sub) => {
          const config = statusConfig[sub.status] ?? statusConfig.active;
          return (
            <Card
              key={sub.id}
              className={`border-l-4 ${config.borderClass} cursor-pointer hover:bg-muted/30 transition-colors`}
              onClick={() => openEdit(sub)}
            >
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <CreditCard className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">{sub.name}</h3>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        <Badge className={config.badgeClass}>
                          {config.label}
                        </Badge>
                        <Badge variant="outline">
                          {frequencyLabels[sub.frequency] ?? sub.frequency}
                        </Badge>
                        {sub.categoryName && (
                          <Badge variant="secondary">{sub.categoryName}</Badge>
                        )}
                        {sub.nextDate && (
                          <Badge
                            variant="outline"
                            className="gap-1 text-xs"
                          >
                            <CalendarDays className="h-3 w-3" />
                            {formatDate(sub.nextDate)}
                          </Badge>
                        )}
                        {sub.cancelReminderDate && (
                          <Badge className="bg-orange-100 text-orange-700 border-orange-200 gap-1">
                            <Bell className="h-3 w-3" />
                            Remind {formatDate(sub.cancelReminderDate)}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    <div className="text-right mr-2">
                      <p className="font-bold text-lg">
                        {formatCurrency(sub.amount, sub.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        /{sub.frequency}
                      </p>
                    </div>
                    {/* Status toggle buttons */}
                    {sub.status === "active" && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Pause"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStatusChange(sub, "paused");
                          }}
                        >
                          <Pause className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title={
                            sub.cancelReminderDate
                              ? "Remove cancel reminder"
                              : "Set cancel reminder"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCancelReminder(sub);
                          }}
                        >
                          {sub.cancelReminderDate ? (
                            <BellOff className="h-4 w-4 text-orange-500" />
                          ) : (
                            <Bell className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-rose-500"
                          title="Cancel"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStatusChange(sub, "cancelled");
                          }}
                        >
                          <XCircle className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                    {sub.status === "paused" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Resume"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStatusChange(sub, "active");
                        }}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    )}
                    {sub.status === "cancelled" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Reactivate"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStatusChange(sub, "active");
                        }}
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(sub.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Subscriptions</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track recurring subscriptions and set cancel reminders
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleDetect} disabled={detecting}>
            <Zap className="h-4 w-4 mr-1" />
            {detecting ? "Detecting..." : "Auto-detect"}
          </Button>
          <Dialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) resetForm();
            }}
          >
            <DialogTrigger render={<Button />}>
              <Plus className="h-4 w-4 mr-1" /> Add Subscription
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {editSub ? "Edit Subscription" : "New Subscription"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <Label>Name</Label>
                  <Input
                    value={form.name}
                    onChange={(e) =>
                      setForm({ ...form, name: e.target.value })
                    }
                    placeholder="e.g. Netflix, Spotify"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Amount</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={form.amount}
                      onChange={(e) =>
                        setForm({ ...form, amount: e.target.value })
                      }
                      required
                    />
                  </div>
                  <div>
                    <Label>Frequency</Label>
                    <Select
                      value={form.frequency}
                      onValueChange={(v) =>
                        setForm({ ...form, frequency: v ?? "monthly" })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="weekly">Weekly</SelectItem>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="quarterly">Quarterly</SelectItem>
                        <SelectItem value="annual">Annual</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Currency</Label>
                    <Combobox
                      value={form.currency}
                      onValueChange={(v) => setForm({ ...form, currency: v || "CAD" })}
                      items={sortCurrency(
                        ["CAD", "USD", "EUR", "GBP"].map((c): ComboboxItemShape => ({ value: c, label: c })),
                        (c) => c.value,
                        (a, z) => a.label.localeCompare(z.label),
                      )}
                      placeholder="CAD"
                      searchPlaceholder="Search…"
                      emptyMessage="No matches"
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label>Next Date</Label>
                    <Input
                      type="date"
                      value={form.nextDate}
                      onChange={(e) =>
                        setForm({ ...form, nextDate: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Category</Label>
                    <Combobox
                      value={form.categoryId}
                      onValueChange={(v) => setForm({ ...form, categoryId: v })}
                      items={sortCategory(
                        categories.map((c): ComboboxItemShape => ({ value: String(c.id), label: c.name })),
                        (c) => Number(c.value),
                        (a, z) => a.label.localeCompare(z.label),
                      )}
                      placeholder="None"
                      searchPlaceholder="Search categories…"
                      emptyMessage="No matches"
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label>Account</Label>
                    <Combobox
                      value={form.accountId}
                      onValueChange={(v) => setForm({ ...form, accountId: v })}
                      items={sortAccount(
                        accounts.map((a): ComboboxItemShape => ({ value: String(a.id), label: a.name })),
                        (a) => Number(a.value),
                        (a, z) => a.label.localeCompare(z.label),
                      )}
                      placeholder="None"
                      searchPlaceholder="Search accounts…"
                      emptyMessage="No matches"
                      className="w-full"
                    />
                  </div>
                </div>
                <div>
                  <Label>Cancel Reminder Date</Label>
                  <Input
                    type="date"
                    value={form.cancelReminderDate}
                    onChange={(e) =>
                      setForm({ ...form, cancelReminderDate: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label>Notes</Label>
                  <Input
                    value={form.notes}
                    onChange={(e) =>
                      setForm({ ...form, notes: e.target.value })
                    }
                  />
                </div>
                <Button type="submit" className="w-full">
                  {editSub ? "Save Changes" : "Add Subscription"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100">
              <DollarSign className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Monthly Cost</p>
              <p className="text-2xl font-bold">
                {formatCurrency(totalMonthly, "CAD")}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100">
              <CalendarDays className="h-5 w-5 text-rose-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Annual Cost</p>
              <p className="text-2xl font-bold text-rose-600">
                {formatCurrency(totalAnnual, "CAD")}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
              <CreditCard className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Active</p>
              <p className="text-2xl font-bold">
                {activeSubs.length}{" "}
                <span className="text-base font-normal text-muted-foreground">
                  / {subs.length}
                </span>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sort controls */}
      {subs.length > 0 && (
        <div className="flex items-center gap-2">
          <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Sort by:</span>
          {(["name", "amount", "nextDate"] as SortField[]).map((field) => (
            <Button
              key={field}
              variant={sortField === field ? "default" : "outline"}
              size="sm"
              onClick={() => setSortField(field)}
            >
              {field === "nextDate" ? "Next Date" : field.charAt(0).toUpperCase() + field.slice(1)}
            </Button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {subs.length === 0 && (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted mb-4">
              <CreditCard className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-1">
              No subscriptions yet
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              Add your recurring subscriptions manually or use auto-detect to
              find them from your transaction history.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Subscription lists grouped by status */}
      {renderSubList(
        activeSubs,
        "Active",
        <Play className="h-5 w-5 text-emerald-500" />
      )}
      {renderSubList(
        pausedSubs,
        "Paused",
        <Pause className="h-5 w-5 text-amber-500" />
      )}
      {renderSubList(
        cancelledSubs,
        "Cancelled",
        <XCircle className="h-5 w-5 text-rose-500" />
      )}

      {/* Auto-detect results dialog */}
      <Dialog open={detectDialogOpen} onOpenChange={setDetectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Detected Subscriptions</DialogTitle>
          </DialogHeader>
          {detected.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No recurring subscriptions detected from your transactions.
            </p>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {detected.map((d) => (
                <div
                  key={d.name}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div>
                    <p className="font-medium">{d.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatCurrency(d.amount, "CAD")} /{d.frequency} --{" "}
                      {d.count} occurrences
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Next: {formatDate(d.nextDate)}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => addDetected(d)}>
                    <Plus className="h-4 w-4 mr-1" /> Add
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function SubscriptionsPage() { return <DevModeGuard><SubscriptionsPageContent /></DevModeGuard>; }
