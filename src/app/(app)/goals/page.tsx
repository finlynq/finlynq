"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { Plus, Trash2, Target, CheckCircle2, TrendingUp, Calendar } from "lucide-react";

type Goal = {
  id: number; name: string; type: string; targetAmount: number; currentAmount: number;
  deadline: string | null; accountName: string | null; priority: number; status: string;
  progress: number; remaining: number; monthlyNeeded: number; note: string;
};
type Account = { id: number; name: string };

const goalTypeConfig: Record<string, { label: string; badgeClass: string; borderClass: string }> = {
  savings: { label: "Savings", badgeClass: "bg-emerald-100 text-emerald-700 border-emerald-200", borderClass: "border-l-emerald-500" },
  debt_payoff: { label: "Debt Payoff", badgeClass: "bg-rose-100 text-rose-700 border-rose-200", borderClass: "border-l-rose-500" },
  investment: { label: "Investment", badgeClass: "bg-indigo-100 text-indigo-700 border-indigo-200", borderClass: "border-l-indigo-500" },
  emergency_fund: { label: "Emergency Fund", badgeClass: "bg-amber-100 text-amber-700 border-amber-200", borderClass: "border-l-amber-500" },
};

function progressColorClass(progress: number): string {
  if (progress < 33) return "[&_[data-slot=progress-indicator]]:bg-rose-500";
  if (progress <= 66) return "[&_[data-slot=progress-indicator]]:bg-amber-500";
  return "[&_[data-slot=progress-indicator]]:bg-emerald-500";
}

function progressTextClass(progress: number): string {
  if (progress < 33) return "text-rose-600";
  if (progress <= 66) return "text-amber-600";
  return "text-emerald-600";
}

export default function GoalsPage() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ name: "", type: "savings", targetAmount: "", deadline: "", accountId: "", priority: "1", note: "" });
  const [errors, setErrors] = useState<{ name?: string; targetAmount?: string }>({});

  function validateForm() {
    const e: { name?: string; targetAmount?: string } = {};
    if (!form.name.trim()) e.name = "Name is required";
    if (!form.targetAmount || parseFloat(form.targetAmount) <= 0) e.targetAmount = "Target amount must be greater than 0";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const isFormValid = form.name.trim() !== "" && form.targetAmount !== "" && parseFloat(form.targetAmount) > 0;

  const load = useCallback(() => { fetch("/api/goals").then((r) => r.json()).then(setGoals); }, []);
  useEffect(() => { load(); fetch("/api/accounts").then((r) => r.json()).then(setAccounts); }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateForm()) return;
    await fetch("/api/goals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, type: form.type, targetAmount: parseFloat(form.targetAmount), deadline: form.deadline || null, accountId: form.accountId ? parseInt(form.accountId) : null, priority: parseInt(form.priority), note: form.note }) });
    setDialogOpen(false);
    setForm({ name: "", type: "savings", targetAmount: "", deadline: "", accountId: "", priority: "1", note: "" });
    setErrors({});
    load();
  }

  async function toggleStatus(goal: Goal) {
    await fetch("/api/goals", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: goal.id, status: goal.status === "active" ? "completed" : "active" }) });
    load();
  }

  async function handleDelete(id: number) {
    await fetch(`/api/goals?id=${id}`, { method: "DELETE" });
    load();
  }

  const active = goals.filter((g) => g.status === "active");
  const completed = goals.filter((g) => g.status === "completed");
  const totalTarget = active.reduce((s, g) => s + g.targetAmount, 0);
  const totalCurrent = active.reduce((s, g) => s + g.currentAmount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Financial Goals</h1>
          <p className="text-sm text-muted-foreground mt-1">Track your savings targets and measure progress over time</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button />}><Plus className="h-4 w-4 mr-1" /> Add Goal</DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New Financial Goal</DialogTitle></DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <Label>Goal Name</Label>
                <Input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setErrors({ ...errors, name: "" }); }} placeholder="e.g. Emergency Fund" />
                {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Type</Label>
                  <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v ?? "savings" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="savings">Savings</SelectItem>
                      <SelectItem value="debt_payoff">Debt Payoff</SelectItem>
                      <SelectItem value="investment">Investment</SelectItem>
                      <SelectItem value="emergency_fund">Emergency Fund</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Target Amount</Label>
                  <Input type="number" step="0.01" value={form.targetAmount} onChange={(e) => { setForm({ ...form, targetAmount: e.target.value }); setErrors({ ...errors, targetAmount: "" }); }} />
                  {errors.targetAmount && <p className="text-xs text-destructive mt-1">{errors.targetAmount}</p>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Deadline</Label><Input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} /></div>
                <div><Label>Priority</Label>
                  <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v ?? "1" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">High</SelectItem>
                      <SelectItem value="2">Medium</SelectItem>
                      <SelectItem value="3">Low</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div><Label>Link to Account</Label>
                <Select value={form.accountId} onValueChange={(v) => setForm({ ...form, accountId: v ?? "" })}>
                  <SelectTrigger><SelectValue placeholder="None (manual tracking)" /></SelectTrigger>
                  <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div><Label>Note</Label><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
              <Button type="submit" className="w-full" disabled={!isFormValid}>Create Goal</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100">
              <Target className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Target</p>
              <p className="text-2xl font-bold">{formatCurrency(totalTarget, "CAD")}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
              <TrendingUp className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Current Progress</p>
              <p className="text-2xl font-bold text-emerald-600">{formatCurrency(totalCurrent, "CAD")}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100">
              <CheckCircle2 className="h-5 w-5 text-violet-600" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Completed</p>
              <p className="text-2xl font-bold">{completed.length} <span className="text-base font-normal text-muted-foreground">/ {goals.length}</span></p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Empty state */}
      {active.length === 0 && (
        <Card>
          <CardContent className="py-14 flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-100 dark:bg-indigo-950/60 mb-4">
              <Target className="h-7 w-7 text-indigo-600 dark:text-indigo-400" />
            </div>
            <h3 className="text-lg font-semibold mb-1">No active goals yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mb-5">
              Set a financial goal to start tracking your progress — saving for an emergency fund, paying off debt, or building investments.
            </p>
            <button
              onClick={() => setDialogOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add your first goal
            </button>
          </CardContent>
        </Card>
      )}

      {/* Active goals */}
      {active.map((g) => {
        const config = goalTypeConfig[g.type] ?? goalTypeConfig.savings;
        return (
          <Card key={g.id} className={`border-l-4 ${config.borderClass}`}>
            <CardContent className="pt-6">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Target className="h-5 w-5 text-primary" />
                  <div>
                    <h3 className="font-semibold">{g.name}</h3>
                    <div className="flex flex-wrap gap-2 mt-1">
                      <Badge className={config.badgeClass}>{config.label}</Badge>
                      {g.accountName && <Badge variant="secondary">{g.accountName}</Badge>}
                      {g.deadline && (
                        <Badge variant="outline" className="gap-1">
                          <Calendar className="h-3 w-3" />
                          {g.deadline}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleStatus(g)}><CheckCircle2 className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleDelete(g.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>{formatCurrency(g.currentAmount, "CAD")} of {formatCurrency(g.targetAmount, "CAD")}</span>
                  <span className={`font-bold ${progressTextClass(g.progress)}`}>{g.progress}%</span>
                </div>
                <Progress value={g.progress} className={`h-3 ${progressColorClass(g.progress)}`} />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Remaining: <span className="font-medium text-foreground">{formatCurrency(g.remaining, "CAD")}</span></span>
                  {g.monthlyNeeded > 0 && (
                    <span className="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200">
                      {formatCurrency(g.monthlyNeeded, "CAD")}/mo needed
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Completed goals */}
      {completed.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-muted-foreground flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            Completed Goals
          </h2>
          {completed.map((g) => (
            <Card key={g.id} className="border-l-4 border-l-emerald-400 bg-emerald-50/30">
              <CardContent className="py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
                  <div>
                    <span className="line-through text-muted-foreground">{g.name}</span>
                    <Badge className="ml-2 bg-emerald-100 text-emerald-700 border-emerald-200">{formatCurrency(g.targetAmount, "CAD")}</Badge>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggleStatus(g)} title="Reactivate">
                    <Target className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDelete(g.id)}><Trash2 className="h-3 w-3" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
