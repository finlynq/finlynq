"use client";

import { useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Upload,
  Settings as SettingsIcon,
  Sparkles,
  Link2,
  ArrowLeftRight,
  Plus,
  Pencil,
  Check,
  X,
  Trash2,
  Zap,
  ShieldCheck,
  Eye,
  Info,
  ChevronDown,
} from "lucide-react";

type Mode = "auto" | "approve" | "manual";

type Suggestion =
  | { kind: "match"; tx: string; category: string }
  | { kind: "create"; category: string }
  | { kind: "transfer"; counter: string; amount: number }
  | { kind: "rule"; ruleName: string; category: string }
  | { kind: "none" };

type Row = {
  id: string;
  date: string;
  payee: string;
  amount: number;
  suggestion: Suggestion;
  // For Reconciled tab: how did it get there?
  resolvedBy?: "rule" | "auto-suggestion" | "manual";
};

type Account = {
  id: string;
  label: string;
  currency: string;
  balanceBank: number;
  balanceFlq: number;
  mode: Mode;
};

const MODES: Record<Mode, { label: string; subLabel: string; icon: typeof Zap; gates: number; tone: string }> = {
  auto: {
    label: "Auto-pilot",
    subLabel: "File → ledger. Rules auto-categorize.",
    icon: Zap,
    gates: 0,
    tone: "text-emerald-500 bg-emerald-500/10 border-emerald-500/30",
  },
  approve: {
    label: "Approve-each",
    subLabel: "File → bank. You approve each ledger entry.",
    icon: ShieldCheck,
    gates: 1,
    tone: "text-sky-500 bg-sky-500/10 border-sky-500/30",
  },
  manual: {
    label: "Manual review",
    subLabel: "Two gates: review the parse, then approve each ledger entry.",
    icon: Eye,
    gates: 2,
    tone: "text-amber-500 bg-amber-500/10 border-amber-500/30",
  },
};

const INITIAL_ACCOUNTS: Account[] = [
  { id: "chq", label: "Chequing", currency: "CAD", balanceBank: 4128.32, balanceFlq: 4128.32, mode: "auto" },
  { id: "vis", label: "Visa Rewards", currency: "CAD", balanceBank: -842.17, balanceFlq: -842.17, mode: "approve" },
  { id: "ibkr", label: "IBKR Investments", currency: "USD", balanceBank: 14820.55, balanceFlq: 14820.55, mode: "manual" },
];

const SAMPLE_NEEDS_REVIEW: Row[] = [
  { id: "nr1", date: "2026-05-26", payee: "STMT LINE 0042", amount: -245.0, suggestion: { kind: "none" } },
  { id: "nr2", date: "2026-05-26", payee: "STMT LINE 0043", amount: 1200.0, suggestion: { kind: "none" } },
  { id: "nr3", date: "2026-05-26", payee: "STMT LINE 0044", amount: -89.45, suggestion: { kind: "none" } },
];

const SAMPLE_TO_APPROVE: Row[] = [
  { id: "ta1", date: "2026-05-26", payee: "Metro", amount: -113.47, suggestion: { kind: "match", tx: "tx #4821 · Metro", category: "Groceries" } },
  { id: "ta2", date: "2026-05-25", payee: "PAI NORTHERN", amount: -38.26, suggestion: { kind: "create", category: "Restaurants" } },
  { id: "ta3", date: "2026-05-25", payee: "E-TRANSFER FROM SAVINGS", amount: 500.0, suggestion: { kind: "transfer", counter: "High-Interest Savings", amount: -500 } },
  { id: "ta4", date: "2026-05-24", payee: "AMZ*MARKETPLACE", amount: -54.92, suggestion: { kind: "rule", ruleName: "Amazon → Shopping", category: "Shopping" } },
];

const SAMPLE_TO_CATEGORIZE: Row[] = [
  { id: "tc1", date: "2026-05-24", payee: "PHANTOM COFFEE", amount: -8.5, suggestion: { kind: "none" } },
  { id: "tc2", date: "2026-05-23", payee: "RANDOM MERCHANT", amount: -22.0, suggestion: { kind: "none" } },
];

const SAMPLE_RECONCILED: Row[] = [
  { id: "r1", date: "2026-05-21", payee: "Starbucks", amount: -6.5, suggestion: { kind: "match", tx: "tx #4801", category: "Coffee" }, resolvedBy: "rule" },
  { id: "r2", date: "2026-05-20", payee: "Payroll", amount: 3214.0, suggestion: { kind: "match", tx: "tx #4799", category: "Salary" }, resolvedBy: "rule" },
  { id: "r3", date: "2026-05-19", payee: "Loblaws", amount: -67.12, suggestion: { kind: "create", category: "Groceries" }, resolvedBy: "auto-suggestion" },
  { id: "r4", date: "2026-05-18", payee: "Shell #4421", amount: -64.0, suggestion: { kind: "create", category: "Transportation" }, resolvedBy: "manual" },
];

function fmtCurrency(n: number, ccy = "CAD") {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}${ccy === "CAD" ? "" : " " + ccy}`;
}

function SuggestionLine({ s }: { s: Suggestion }) {
  if (s.kind === "match") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <Link2 className="h-3.5 w-3.5 text-sky-500" />
        <span className="text-muted-foreground">match</span>
        <span className="text-muted-foreground">{s.tx}</span>
      </span>
    );
  }
  if (s.kind === "create") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <Plus className="h-3.5 w-3.5 text-emerald-500" />
        <span className="text-muted-foreground">create as</span>
        <Badge variant="secondary" className="font-mono text-[10px]">{s.category}</Badge>
      </span>
    );
  }
  if (s.kind === "transfer") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <ArrowLeftRight className="h-3.5 w-3.5 text-indigo-500" />
        <span className="text-muted-foreground">transfer ↔ {s.counter} ({fmtCurrency(s.amount)})</span>
      </span>
    );
  }
  if (s.kind === "rule") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-muted-foreground">rule:</span>
        <span className="font-medium">{s.ruleName}</span>
      </span>
    );
  }
  return <span className="text-xs italic text-muted-foreground">no match — needs your decision</span>;
}

function ResolvedByPill({ kind }: { kind: NonNullable<Row["resolvedBy"]> }) {
  if (kind === "rule") {
    return (
      <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase tracking-wider border-amber-500/40 text-amber-600 dark:text-amber-400">
        <Sparkles className="h-2.5 w-2.5" /> rule
      </Badge>
    );
  }
  if (kind === "auto-suggestion") {
    return (
      <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase tracking-wider border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
        <Zap className="h-2.5 w-2.5" /> auto
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase tracking-wider border-muted-foreground/40 text-muted-foreground">
      <Check className="h-2.5 w-2.5" /> manual
    </Badge>
  );
}

function RowCard({
  row,
  primaryLabel,
  onPrimary,
  onDismiss,
}: {
  row: Row;
  primaryLabel: string;
  onPrimary: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="rounded-lg border bg-card hover:shadow-sm transition-shadow">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="text-xs font-mono text-muted-foreground">{row.date}</span>
            <span className="text-sm font-medium truncate">{row.payee}</span>
            <span className={`ml-auto text-sm font-mono ${row.amount < 0 ? "text-rose-500" : "text-emerald-500"}`}>
              {fmtCurrency(row.amount)}
            </span>
          </div>
          <div className="mt-1.5">
            <SuggestionLine s={row.suggestion} />
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {row.suggestion.kind !== "none" ? (
            <Button size="sm" className="h-7 gap-1" onClick={() => onPrimary(row.id)}>
              <Check className="h-3.5 w-3.5" /> {primaryLabel}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" className="h-7 gap-1">
              <Plus className="h-3.5 w-3.5" /> Categorize
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditing((e) => !e)} aria-label="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-500" onClick={() => onDismiss(row.id)} aria-label="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {editing && (
        <div className="border-t bg-muted/30 px-4 py-3 space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Payee</label>
              <Input defaultValue={row.payee} className="h-8" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Category</label>
              <Input className="h-8" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" className="h-7" onClick={() => { setEditing(false); onPrimary(row.id); }}>Save</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReconciledRow({ row }: { row: Row }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-4 py-2.5 opacity-90 hover:opacity-100 transition-opacity">
      <div className="flex items-baseline gap-3">
        <span className="text-xs font-mono text-muted-foreground">{row.date}</span>
        <span className="text-sm truncate">{row.payee}</span>
        {row.resolvedBy && <ResolvedByPill kind={row.resolvedBy} />}
        {row.suggestion.kind === "create" && (
          <Badge variant="secondary" className="text-[10px] font-mono">{row.suggestion.category}</Badge>
        )}
        {row.suggestion.kind === "match" && (
          <Badge variant="secondary" className="text-[10px] font-mono">{row.suggestion.category}</Badge>
        )}
        <span className={`ml-auto text-sm font-mono ${row.amount < 0 ? "text-rose-500" : "text-emerald-500"}`}>
          {fmtCurrency(row.amount)}
        </span>
      </div>
    </div>
  );
}

function ModeChip({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const cfg = MODES[mode];
  const Icon = cfg.icon;
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${cfg.tone}`}
        aria-label="Change account mode"
      >
        <Icon className="h-3.5 w-3.5" />
        {cfg.label}
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-2 z-30 w-[320px] rounded-lg border bg-popover shadow-xl p-1">
            {(Object.keys(MODES) as Mode[]).map((m) => {
              const c = MODES[m];
              const I = c.icon;
              const active = m === mode;
              return (
                <button
                  key={m}
                  onClick={() => { onChange(m); setOpen(false); }}
                  className={`w-full text-left p-2.5 rounded-md transition-colors ${active ? "bg-muted" : "hover:bg-muted/50"}`}
                >
                  <div className="flex items-center gap-2">
                    <I className={`h-4 w-4 ${c.tone.split(" ")[0]}`} />
                    <span className="text-sm font-medium">{c.label}</span>
                    <Badge variant="outline" className="ml-auto text-[10px] font-mono">{c.gates} {c.gates === 1 ? "gate" : "gates"}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 ml-6">{c.subLabel}</p>
                </button>
              );
            })}
            <div className="border-t mt-1 pt-2 px-2 pb-1">
              <p className="text-[10px] text-muted-foreground">Same backend pipeline — only the gates you see change.</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function ReconcileV3Preview() {
  const [accounts, setAccounts] = useState(INITIAL_ACCOUNTS);
  const [accountId, setAccountId] = useState("chq");
  const [uploadOpen, setUploadOpen] = useState(false);

  // Per-account data buckets (mock — in reality this comes from the backend per account)
  const [data, setData] = useState(() => ({
    chq: {
      needsReview: [] as Row[],          // empty in auto mode
      toApprove: [] as Row[],            // empty in auto mode
      toCategorize: SAMPLE_TO_CATEGORIZE,
      reconciled: SAMPLE_RECONCILED,
    },
    vis: {
      needsReview: [] as Row[],
      toApprove: SAMPLE_TO_APPROVE,
      toCategorize: [] as Row[],
      reconciled: SAMPLE_RECONCILED.slice(0, 2),
    },
    ibkr: {
      needsReview: SAMPLE_NEEDS_REVIEW,
      toApprove: SAMPLE_TO_APPROVE.slice(0, 2),
      toCategorize: [] as Row[],
      reconciled: SAMPLE_RECONCILED.slice(0, 1),
    },
  }));

  const account = accounts.find((a) => a.id === accountId)!;
  const accountData = data[accountId as keyof typeof data];
  const mode = account.mode;
  const modeCfg = MODES[mode];

  // Default tab depends on mode
  const defaultTab = mode === "manual" ? "needs-review" : mode === "approve" ? "to-approve" : "to-categorize";
  const [tab, setTab] = useState(defaultTab);

  // When mode changes, snap to a tab that exists in the new mode
  const setMode = (m: Mode) => {
    setAccounts((accs) => accs.map((a) => (a.id === accountId ? { ...a, mode: m } : a)));
    const nextDefault = m === "manual" ? "needs-review" : m === "approve" ? "to-approve" : "to-categorize";
    setTab(nextDefault);
  };

  // Counts visible per tab
  const counts = {
    needsReview: accountData.needsReview.length,
    toApprove: accountData.toApprove.length,
    toCategorize: accountData.toCategorize.length,
    reconciled: accountData.reconciled.length,
  };

  const visibleTabs = useMemo<string[]>(() => {
    if (mode === "manual") return ["needs-review", "to-approve", "reconciled", "advanced"];
    if (mode === "approve") return ["to-approve", "reconciled", "advanced"];
    return ["to-categorize", "reconciled", "advanced"];
  }, [mode]);

  // Mock state transitions
  const moveRow = (from: keyof typeof accountData, to: keyof typeof accountData, id: string, resolvedBy?: Row["resolvedBy"]) => {
    setData((d) => {
      const acc = d[accountId as keyof typeof d];
      const row = (acc[from] as Row[]).find((r) => r.id === id);
      if (!row) return d;
      const next = {
        ...acc,
        [from]: (acc[from] as Row[]).filter((r) => r.id !== id),
        [to]: [{ ...row, resolvedBy }, ...(acc[to] as Row[])],
      };
      return { ...d, [accountId]: next };
    });
  };

  const dismiss = (id: string) => {
    setData((d) => {
      const acc = d[accountId as keyof typeof d];
      return {
        ...d,
        [accountId]: {
          needsReview: acc.needsReview.filter((r) => r.id !== id),
          toApprove: acc.toApprove.filter((r) => r.id !== id),
          toCategorize: acc.toCategorize.filter((r) => r.id !== id),
          reconciled: acc.reconciled.filter((r) => r.id !== id),
        },
      };
    });
  };

  // What "primary action" does per tab depends on mode
  const acceptFromNeedsReview = (id: string) => moveRow("needsReview", "toApprove", id);
  const acceptFromToApprove = (id: string) => moveRow("toApprove", "reconciled", id, "auto-suggestion");
  const acceptFromToCategorize = (id: string) => moveRow("toCategorize", "reconciled", id, "manual");

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Reconcile</h1>
            <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider">Preview v3 · per-account modes</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Each account picks how much friction it wants. Same backend, different gates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" className="gap-1.5">
            <SettingsIcon className="h-4 w-4" /> Settings
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setUploadOpen(true)}>
            <Upload className="h-4 w-4" /> Upload
          </Button>
        </div>
      </div>

      {/* Account + Mode + Balance */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Account</span>
            <Select value={accountId} onValueChange={(v) => { setAccountId(v ?? "chq"); }}>
              <SelectTrigger className="w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label} · {a.currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ModeChip mode={mode} onChange={setMode} />
          <div className="h-8 w-px bg-border" />
          <div className="flex items-center gap-6 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Bank</div>
              <div className="font-mono">{fmtCurrency(account.balanceBank, account.currency)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Ledger</div>
              <div className="font-mono">{fmtCurrency(account.balanceFlq, account.currency)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Δ</div>
              <div className="font-mono text-emerald-500">$0.00 ✓</div>
            </div>
          </div>
        </div>
        <div className={`mt-3 rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${modeCfg.tone}`}>
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">{modeCfg.label}</span> · {modeCfg.subLabel} ·{" "}
            <span className="text-muted-foreground">{modeCfg.gates} gate{modeCfg.gates !== 1 ? "s" : ""} between upload and ledger.</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-4">
        <TabsList className="h-9">
          {visibleTabs.includes("needs-review") && (
            <TabsTrigger value="needs-review" className="gap-2">
              Needs review
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">{counts.needsReview}</Badge>
            </TabsTrigger>
          )}
          {visibleTabs.includes("to-approve") && (
            <TabsTrigger value="to-approve" className="gap-2">
              To approve
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">{counts.toApprove}</Badge>
            </TabsTrigger>
          )}
          {visibleTabs.includes("to-categorize") && (
            <TabsTrigger value="to-categorize" className="gap-2">
              To categorize
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">{counts.toCategorize}</Badge>
            </TabsTrigger>
          )}
          <TabsTrigger value="reconciled" className="gap-2">
            Reconciled
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">{counts.reconciled}</Badge>
          </TabsTrigger>
          <TabsTrigger value="advanced">Advanced</TabsTrigger>
        </TabsList>

        {visibleTabs.includes("needs-review") && (
          <TabsContent value="needs-review" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Parsed file rows. Confirm they look right before they hit the bank ledger.
            </p>
            {accountData.needsReview.length === 0 ? (
              <EmptyState label="Nothing staged." />
            ) : (
              accountData.needsReview.map((r) => (
                <RowCard key={r.id} row={r} primaryLabel="Approve" onPrimary={acceptFromNeedsReview} onDismiss={dismiss} />
              ))
            )}
          </TabsContent>
        )}

        {visibleTabs.includes("to-approve") && (
          <TabsContent value="to-approve" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Bank rows with a suggested category. One click commits them to your ledger.
            </p>
            {accountData.toApprove.length === 0 ? (
              <EmptyState label="No rows waiting for approval." />
            ) : (
              accountData.toApprove.map((r) => (
                <RowCard key={r.id} row={r} primaryLabel="Approve" onPrimary={acceptFromToApprove} onDismiss={dismiss} />
              ))
            )}
          </TabsContent>
        )}

        {visibleTabs.includes("to-categorize") && (
          <TabsContent value="to-categorize" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Rules didn&apos;t match these — pick a category to commit them to your ledger.
            </p>
            {accountData.toCategorize.length === 0 ? (
              <EmptyState label="Auto-pilot is handling everything. Nothing manual to do." />
            ) : (
              accountData.toCategorize.map((r) => (
                <RowCard key={r.id} row={r} primaryLabel="Save" onPrimary={acceptFromToCategorize} onDismiss={dismiss} />
              ))
            )}
          </TabsContent>
        )}

        <TabsContent value="reconciled" className="space-y-2">
          {mode === "auto" && accountData.reconciled.some((r) => r.resolvedBy === "rule") && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              <span>
                <span className="font-semibold text-amber-600 dark:text-amber-400">
                  {accountData.reconciled.filter((r) => r.resolvedBy === "rule").length} row{accountData.reconciled.filter((r) => r.resolvedBy === "rule").length !== 1 ? "s" : ""} auto-applied by rules
                </span>{" "}
                <span className="text-muted-foreground">— click any row to see which rule fired and override if needed.</span>
              </span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Fully reconciled rows — both in your bank ledger and in your transaction history.
          </p>
          {accountData.reconciled.length === 0 ? (
            <EmptyState label="Nothing reconciled yet on this account." />
          ) : (
            <div className="space-y-1.5">
              {accountData.reconciled.map((r) => (
                <ReconciledRow key={r.id} row={r} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="advanced" className="space-y-3">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
            <span className="font-semibold">Advanced mode</span> — the existing two-pane + checkbox + N×M bulk-link UX lives here, unchanged. For the messy reconciles the default flow can&apos;t handle (3 tx ↔ 1 bank deposit, etc.).
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transactions</h3>
                <Badge variant="outline" className="text-[10px]">47</Badge>
              </div>
              <p className="text-xs italic text-muted-foreground">(Existing TransactionsPane.)</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bank ledger</h3>
                <Badge variant="outline" className="text-[10px]">52</Badge>
              </div>
              <p className="text-xs italic text-muted-foreground">(Existing BankPane.)</p>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Upload drawer */}
      {uploadOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={() => setUploadOpen(false)} />
          <div className="fixed right-0 top-0 z-50 h-full w-full max-w-md border-l bg-background shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">Upload to {account.label}</h2>
                <p className="text-xs text-muted-foreground">{modeCfg.label} · {modeCfg.gates} gate{modeCfg.gates !== 1 ? "s" : ""}</p>
              </div>
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => setUploadOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="p-5 space-y-5 flex-1">
              <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/20 px-6 py-10 text-center">
                <Upload className="mx-auto h-7 w-7 text-muted-foreground/60" />
                <p className="mt-2 text-sm font-medium">Drop file here</p>
                <p className="text-xs text-muted-foreground">CSV · OFX · QFX · XML</p>
              </div>
              <div className={`rounded-md border px-3 py-2.5 text-xs ${modeCfg.tone}`}>
                <p className="font-medium">After upload — {modeCfg.label}:</p>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground list-disc pl-4">
                  {mode === "auto" && (
                    <>
                      <li>Matched rules → straight to <span className="font-medium text-foreground">Reconciled</span></li>
                      <li>Unmatched → <span className="font-medium text-foreground">To categorize</span></li>
                    </>
                  )}
                  {mode === "approve" && (
                    <>
                      <li>Rows land in <span className="font-medium text-foreground">To approve</span> with suggested categories</li>
                      <li>One click per row to commit to ledger</li>
                    </>
                  )}
                  {mode === "manual" && (
                    <>
                      <li>Rows land in <span className="font-medium text-foreground">Needs review</span> for parse-preview check</li>
                      <li>Approved rows move to <span className="font-medium text-foreground">To approve</span> with suggestions</li>
                      <li>Each row needs explicit approval to commit to ledger</li>
                    </>
                  )}
                </ul>
              </div>
            </div>
            <div className="border-t bg-background px-5 py-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setUploadOpen(false)}>Cancel</Button>
              <Button size="sm">Upload</Button>
            </div>
          </div>
        </>
      )}

      <footer className="pt-6 text-[11px] text-muted-foreground border-t mt-8 flex items-center justify-between flex-wrap gap-2">
        <div>
          v3 sandbox · per-account mode toggle · try switching accounts (Chequing=Auto, Visa=Approve, IBKR=Manual) and watch the tabs morph
        </div>
        <div>Flip the mode chip to see the same data through different gates</div>
      </footer>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/10 px-6 py-12 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
