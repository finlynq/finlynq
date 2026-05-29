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
  Save,
  ExternalLink,
  Glasses,
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

const MODES: Record<Mode, { label: string; subLabel: string; icon: typeof Zap; gates: number; tone: string; toneDot: string }> = {
  auto: {
    label: "Auto-pilot",
    subLabel: "File → ledger. Rules auto-categorize.",
    icon: Zap,
    gates: 0,
    tone: "text-emerald-500 bg-emerald-500/10 border-emerald-500/30",
    toneDot: "bg-emerald-500",
  },
  approve: {
    label: "Approve-each",
    subLabel: "File → bank. You approve each ledger entry.",
    icon: ShieldCheck,
    gates: 1,
    tone: "text-sky-500 bg-sky-500/10 border-sky-500/30",
    toneDot: "bg-sky-500",
  },
  manual: {
    label: "Manual review",
    subLabel: "Two gates. Staging two-pane, then bank-vs-transactions two-pane.",
    icon: Eye,
    gates: 2,
    tone: "text-amber-500 bg-amber-500/10 border-amber-500/30",
    toneDot: "bg-amber-500",
  },
};

const INITIAL_ACCOUNTS: Account[] = [
  { id: "chq", label: "Chequing", currency: "CAD", balanceBank: 4128.32, balanceFlq: 4128.32, mode: "auto" },
  { id: "vis", label: "Visa Rewards", currency: "CAD", balanceBank: -842.17, balanceFlq: -842.17, mode: "approve" },
  { id: "ibkr", label: "IBKR Investments", currency: "USD", balanceBank: 14820.55, balanceFlq: 14820.55, mode: "manual" },
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

// Mock data for Manual mode two-pane views
const MOCK_STAGED_FILE_ROWS = [
  { id: "sf1", date: "2026-05-26", payee: "BROKERAGE SETTLEMENT", amount: -1850.0, status: "new" as const },
  { id: "sf2", date: "2026-05-26", payee: "DIVIDEND VTI", amount: 42.18, status: "new" as const },
  { id: "sf3", date: "2026-05-25", payee: "WIRE TRANSFER IN", amount: 5000.0, status: "duplicate" as const },
  { id: "sf4", date: "2026-05-24", payee: "FX CONVERSION USD→CAD", amount: -212.5, status: "new" as const },
];

const MOCK_BANK_CONTEXT_ROWS = [
  { id: "bc1", date: "2026-05-24", payee: "FX CONVERSION USD→CAD", amount: -212.5, status: "existing" as const },
  { id: "bc2", date: "2026-05-23", payee: "TRADE SETTLEMENT AAPL", amount: -2400.0, status: "existing" as const },
  { id: "bc3", date: "2026-05-22", payee: "OPENING BALANCE", amount: 10000.0, status: "existing" as const },
];

const MOCK_BANK_LEDGER_ROWS = [
  { id: "bl1", date: "2026-05-26", payee: "BROKERAGE SETTLEMENT", amount: -1850.0, status: "bank_only" as const },
  { id: "bl2", date: "2026-05-26", payee: "DIVIDEND VTI", amount: 42.18, status: "suggested_exact" as const },
  { id: "bl3", date: "2026-05-24", payee: "FX CONVERSION USD→CAD", amount: -212.5, status: "linked" as const },
  { id: "bl4", date: "2026-05-23", payee: "TRADE SETTLEMENT AAPL", amount: -2400.0, status: "suggested_fuzzy" as const },
];

const MOCK_TX_ROWS = [
  { id: "tx1", date: "2026-05-26", payee: "Vanguard ETF Dividend", amount: 42.18, status: "suggested_exact" as const },
  { id: "tx2", date: "2026-05-24", payee: "FX USD→CAD @ 0.7273", amount: -212.5, status: "linked" as const },
  { id: "tx3", date: "2026-05-23", payee: "AAPL Buy 16 sh", amount: -2400.0, status: "suggested_fuzzy" as const },
  { id: "tx4", date: "2026-05-22", payee: "Account Opening", amount: 10000.0, status: "tx_only" as const },
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
        <span className="text-muted-foreground">match {s.tx}</span>
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
      <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase border-amber-500/40 text-amber-600 dark:text-amber-400">
        <Sparkles className="h-2.5 w-2.5" /> rule
      </Badge>
    );
  }
  if (kind === "auto-suggestion") {
    return (
      <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
        <Zap className="h-2.5 w-2.5" /> auto
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-[10px] font-mono uppercase border-muted-foreground/40 text-muted-foreground">
      <Check className="h-2.5 w-2.5" /> manual
    </Badge>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    new: { label: "new", cls: "border-sky-500/40 text-sky-600 dark:text-sky-400" },
    duplicate: { label: "duplicate", cls: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
    existing: { label: "existing", cls: "border-muted-foreground/30 text-muted-foreground" },
    bank_only: { label: "bank-only", cls: "border-rose-500/40 text-rose-500" },
    linked: { label: "linked", cls: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
    suggested_exact: { label: "exact match", cls: "border-sky-500/40 text-sky-600 dark:text-sky-400" },
    suggested_fuzzy: { label: "fuzzy match", cls: "border-indigo-500/40 text-indigo-600 dark:text-indigo-400" },
    tx_only: { label: "tx-only", cls: "border-purple-500/40 text-purple-500" },
  };
  const c = map[status] ?? { label: status, cls: "" };
  return (
    <Badge variant="outline" className={`text-[10px] font-mono ${c.cls}`}>
      {c.label}
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
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditing((e) => !e)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-500" onClick={() => onDismiss(row.id)}>
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
        {(row.suggestion.kind === "create" || row.suggestion.kind === "match") && (
          <Badge variant="secondary" className="text-[10px] font-mono">{row.suggestion.category}</Badge>
        )}
        <span className={`ml-auto text-sm font-mono ${row.amount < 0 ? "text-rose-500" : "text-emerald-500"}`}>
          {fmtCurrency(row.amount)}
        </span>
      </div>
    </div>
  );
}

// ─── Manual mode: two-pane mocks ───────────────────────────────────────

function PaneRow({
  date, payee, amount, status, ccy = "CAD",
}: { date: string; payee: string; amount: number; status: string; ccy?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b last:border-b-0 hover:bg-muted/30 cursor-pointer">
      <input type="checkbox" className="h-3.5 w-3.5" />
      <span className="text-[11px] font-mono text-muted-foreground w-20 shrink-0">{date}</span>
      <span className="text-xs truncate flex-1">{payee}</span>
      <StatusPill status={status} />
      <span className={`text-xs font-mono w-24 text-right shrink-0 ${amount < 0 ? "text-rose-500" : "text-emerald-500"}`}>
        {fmtCurrency(amount, ccy)}
      </span>
    </div>
  );
}

function ManualStagingView({ ccy }: { ccy: string }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2.5 text-xs flex items-start gap-2">
        <Info className="h-3.5 w-3.5 mt-0.5 text-sky-500 shrink-0" />
        <div>
          <span className="font-semibold text-sky-700 dark:text-sky-300">Staging review.</span>{" "}
          <span className="text-muted-foreground">
            Left: rows parsed from your latest upload, not yet in the bank ledger. Right: existing ledger context for sanity-check. Approve to commit; the rows then move to the Reconcile tab.
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Left: staged file rows */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
            <div className="flex items-center gap-2">
              <input type="checkbox" className="h-3.5 w-3.5" />
              <h3 className="text-xs font-semibold uppercase tracking-wider">Staged file rows</h3>
              <Badge variant="secondary" className="text-[10px] font-mono">{MOCK_STAGED_FILE_ROWS.length}</Badge>
            </div>
            <span className="text-[10px] text-muted-foreground">ibkr-2026-05-26.ofx</span>
          </div>
          <div>
            {MOCK_STAGED_FILE_ROWS.map((r) => (
              <PaneRow key={r.id} date={r.date} payee={r.payee} amount={r.amount} status={r.status} ccy={ccy} />
            ))}
          </div>
        </div>

        {/* Right: existing bank ledger context */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider">Bank ledger (context)</h3>
              <Badge variant="secondary" className="text-[10px] font-mono">{MOCK_BANK_CONTEXT_ROWS.length}</Badge>
            </div>
            <span className="text-[10px] text-muted-foreground">last 7 days</span>
          </div>
          <div>
            {MOCK_BANK_CONTEXT_ROWS.map((r) => (
              <PaneRow key={r.id} date={r.date} payee={r.payee} amount={r.amount} status={r.status} ccy={ccy} />
            ))}
          </div>
        </div>
      </div>

      {/* Action bar (mock) */}
      <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-3">
        <div className="text-xs text-muted-foreground">3 new · 1 duplicate · 0 errors</div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-8">Discard all</Button>
          <Button size="sm" className="h-8 gap-1">
            <Check className="h-3.5 w-3.5" /> Send to bank ledger (3)
          </Button>
        </div>
      </div>
    </div>
  );
}

function ManualReconcileView({ ccy }: { ccy: string }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs flex items-start gap-2">
        <Info className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
        <div>
          <span className="font-semibold text-amber-700 dark:text-amber-400">Reconcile.</span>{" "}
          <span className="text-muted-foreground">
            Left: bank ledger rows. Right: your system transactions. Pair them with checkboxes for N×M bulk-link, or accept inline suggestions. Trash icon removes a bad row.
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Bank ledger pane */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
            <div className="flex items-center gap-2">
              <input type="checkbox" className="h-3.5 w-3.5" />
              <h3 className="text-xs font-semibold uppercase tracking-wider">Bank ledger</h3>
              <Badge variant="secondary" className="text-[10px] font-mono">{MOCK_BANK_LEDGER_ROWS.length}</Badge>
            </div>
          </div>
          <div>
            {MOCK_BANK_LEDGER_ROWS.map((r) => (
              <div key={r.id} className="flex items-center gap-2 px-3 py-2 border-b last:border-b-0 hover:bg-muted/30 group">
                <input type="checkbox" className="h-3.5 w-3.5" />
                <span className="text-[11px] font-mono text-muted-foreground w-20 shrink-0">{r.date}</span>
                <span className="text-xs truncate flex-1">{r.payee}</span>
                <StatusPill status={r.status} />
                <span className={`text-xs font-mono w-24 text-right shrink-0 ${r.amount < 0 ? "text-rose-500" : "text-emerald-500"}`}>
                  {fmtCurrency(r.amount, ccy)}
                </span>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Transactions pane */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
            <div className="flex items-center gap-2">
              <input type="checkbox" className="h-3.5 w-3.5" />
              <h3 className="text-xs font-semibold uppercase tracking-wider">Transactions</h3>
              <Badge variant="secondary" className="text-[10px] font-mono">{MOCK_TX_ROWS.length}</Badge>
            </div>
          </div>
          <div>
            {MOCK_TX_ROWS.map((r) => (
              <PaneRow key={r.id} date={r.date} payee={r.payee} amount={r.amount} status={r.status} ccy={ccy} />
            ))}
          </div>
        </div>
      </div>

      {/* Bulk-link action bar (mock — like the one shipped 2026-05-27) */}
      <div className="rounded-full border bg-card px-4 py-2.5 shadow-md inline-flex items-center gap-3 text-xs">
        <span className="font-mono text-muted-foreground">2 tx (-$2,612.50) × 2 bank (-$2,612.50) = 4 links</span>
        <Badge variant="outline" className="text-[10px] font-mono border-emerald-500/40 text-emerald-500">Δ $0.00 ✓</Badge>
        <Button size="sm" variant="ghost" className="h-6 px-2">Clear</Button>
        <Button size="sm" className="h-7 gap-1">
          <Link2 className="h-3.5 w-3.5" /> Reconcile selected
        </Button>
      </div>
    </div>
  );
}

// ─── Lens chip ──────────────────────────────────────────────────────────

function LensChip({
  lens,
  policy,
  onLensChange,
}: {
  lens: Mode;
  policy: Mode;
  onLensChange: (m: Mode) => void;
}) {
  const cfg = MODES[lens];
  const Icon = cfg.icon;
  const [open, setOpen] = useState(false);
  const isLensActive = lens !== policy;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${cfg.tone} ${isLensActive ? "ring-2 ring-offset-1 ring-offset-background ring-current/40" : ""}`}
      >
        {isLensActive && <Glasses className="h-3.5 w-3.5" />}
        {!isLensActive && <Icon className="h-3.5 w-3.5" />}
        {cfg.label}
        {isLensActive && <span className="text-[9px] uppercase tracking-wider opacity-70">lens</span>}
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-2 z-30 w-[340px] rounded-lg border bg-popover shadow-xl p-1">
            <div className="px-2 py-2 border-b mb-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">View lens</p>
              <p className="text-xs text-muted-foreground mt-0.5">Temporarily see this account through a different gate model. Doesn&apos;t change the account&apos;s policy.</p>
            </div>
            {(Object.keys(MODES) as Mode[]).map((m) => {
              const c = MODES[m];
              const I = c.icon;
              const isLens = m === lens;
              const isPolicy = m === policy;
              return (
                <button
                  key={m}
                  onClick={() => { onLensChange(m); setOpen(false); }}
                  className={`w-full text-left p-2.5 rounded-md transition-colors ${isLens ? "bg-muted" : "hover:bg-muted/50"}`}
                >
                  <div className="flex items-center gap-2">
                    <I className={`h-4 w-4 ${c.tone.split(" ")[0]}`} />
                    <span className="text-sm font-medium">{c.label}</span>
                    {isPolicy && <Badge variant="outline" className="ml-auto text-[10px] font-mono">policy</Badge>}
                    {isLens && !isPolicy && <Badge variant="outline" className="ml-auto text-[10px] font-mono border-current/40">current lens</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 ml-6">{c.subLabel}</p>
                </button>
              );
            })}
            <div className="border-t mt-1 pt-2 pb-1 px-2">
              <button className="w-full text-left inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1">
                <SettingsIcon className="h-3.5 w-3.5" />
                Open account settings (to change the policy)
                <ExternalLink className="h-3 w-3 ml-auto" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Lens toast ─────────────────────────────────────────────────────────

function LensToast({
  lens,
  accountLabel,
  onSave,
  onKeep,
  onRevert,
}: {
  lens: Mode;
  accountLabel: string;
  onSave: () => void;
  onKeep: () => void;
  onRevert: () => void;
}) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 rounded-lg border bg-popover shadow-2xl px-4 py-3 flex items-center gap-3 max-w-[640px]">
      <Glasses className="h-4 w-4 text-foreground shrink-0" />
      <div className="text-xs">
        <p className="font-medium">
          Viewing <span className="font-mono">{accountLabel}</span> through <span className="font-mono">{MODES[lens].label}</span> lens
        </p>
        <p className="text-muted-foreground mt-0.5">
          Layout-only — rows already auto-applied stay reconciled. Save to change the account&apos;s policy too.
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onRevert}>
          Revert
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onKeep}>
          Keep for now
        </Button>
        <Button size="sm" className="h-7 gap-1 text-xs" onClick={onSave}>
          <Save className="h-3.5 w-3.5" /> Save as default
        </Button>
      </div>
    </div>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────

export default function ReconcileV4Preview() {
  const [accounts, setAccounts] = useState(INITIAL_ACCOUNTS);
  const [accountId, setAccountId] = useState("chq");
  const [uploadOpen, setUploadOpen] = useState(false);

  // Per-account row buckets (mock state)
  const [data, setData] = useState(() => ({
    chq: { toApprove: [] as Row[], toCategorize: SAMPLE_TO_CATEGORIZE, reconciled: SAMPLE_RECONCILED },
    vis: { toApprove: SAMPLE_TO_APPROVE, toCategorize: [] as Row[], reconciled: SAMPLE_RECONCILED.slice(0, 2) },
    ibkr: { toApprove: [] as Row[], toCategorize: [] as Row[], reconciled: SAMPLE_RECONCILED.slice(0, 1) },
  }));

  // The lens is per-render; the policy is per-account
  const account = accounts.find((a) => a.id === accountId)!;
  const policy = account.mode;
  const [lens, setLens] = useState<Mode>(policy);
  const [lensToastVisible, setLensToastVisible] = useState(false);

  const isLensActive = lens !== policy;
  const cfg = MODES[lens];

  const accountData = data[accountId as keyof typeof data];

  const defaultTabFor = (m: Mode) =>
    m === "manual" ? "staging" : m === "approve" ? "to-approve" : "to-categorize";
  const [tab, setTab] = useState(defaultTabFor(lens));

  // When switching accounts: reset lens to that account's policy + tab default
  const switchAccount = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    if (!a) return;
    setAccountId(id);
    setLens(a.mode);
    setTab(defaultTabFor(a.mode));
    setLensToastVisible(false);
  };

  // When user changes lens: snap tab + show toast
  const onLensChange = (m: Mode) => {
    setLens(m);
    setTab(defaultTabFor(m));
    setLensToastVisible(m !== policy);
  };

  const visibleTabs: string[] = useMemo(() => {
    if (lens === "manual") return ["staging", "reconcile", "reconciled"];
    if (lens === "approve") return ["to-approve", "reconciled"];
    return ["to-categorize", "reconciled"];
  }, [lens]);

  const counts = {
    toApprove: accountData.toApprove.length,
    toCategorize: accountData.toCategorize.length,
    reconciled: accountData.reconciled.length,
  };

  const moveRow = (from: keyof typeof accountData, to: keyof typeof accountData, id: string, resolvedBy?: Row["resolvedBy"]) => {
    setData((d) => {
      const acc = d[accountId as keyof typeof d];
      const row = (acc[from] as Row[]).find((r) => r.id === id);
      if (!row) return d;
      return {
        ...d,
        [accountId]: {
          ...acc,
          [from]: (acc[from] as Row[]).filter((r) => r.id !== id),
          [to]: [{ ...row, resolvedBy }, ...(acc[to] as Row[])],
        },
      };
    });
  };

  const dismiss = (id: string) => {
    setData((d) => {
      const acc = d[accountId as keyof typeof d];
      return {
        ...d,
        [accountId]: {
          toApprove: acc.toApprove.filter((r) => r.id !== id),
          toCategorize: acc.toCategorize.filter((r) => r.id !== id),
          reconciled: acc.reconciled.filter((r) => r.id !== id),
        },
      };
    });
  };

  const acceptFromToApprove = (id: string) => moveRow("toApprove", "reconciled", id, "auto-suggestion");
  const acceptFromToCategorize = (id: string) => moveRow("toCategorize", "reconciled", id, "manual");

  // Save-as-default writes the lens to account.mode
  const onSavePolicy = () => {
    setAccounts((accs) => accs.map((a) => (a.id === accountId ? { ...a, mode: lens } : a)));
    setLensToastVisible(false);
  };
  const onRevertLens = () => {
    setLens(policy);
    setTab(defaultTabFor(policy));
    setLensToastVisible(false);
  };
  const onKeepLens = () => setLensToastVisible(false);

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Reconcile</h1>
            <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider">Preview v4 · lens + policy</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Manual brings back the two-pane. Chip is a lens, not a setting — the gear inside opens account settings to change the policy.
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

      {/* Account + Lens + Balance */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Account</span>
            <Select value={accountId} onValueChange={(v) => switchAccount(v ?? "chq")}>
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
          <LensChip lens={lens} policy={policy} onLensChange={onLensChange} />
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
        <div className={`mt-3 rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${cfg.tone}`}>
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">{cfg.label}</span> · {cfg.subLabel}
            {isLensActive && (
              <>
                {" · "}
                <span className="font-medium">Policy is {MODES[policy].label}.</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-4">
        <TabsList className="h-9">
          {visibleTabs.includes("staging") && (
            <TabsTrigger value="staging" className="gap-2">
              Staging
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">{MOCK_STAGED_FILE_ROWS.length}</Badge>
            </TabsTrigger>
          )}
          {visibleTabs.includes("reconcile") && (
            <TabsTrigger value="reconcile" className="gap-2">
              Reconcile
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">{MOCK_BANK_LEDGER_ROWS.length}</Badge>
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
        </TabsList>

        {/* Manual: Staging two-pane */}
        {visibleTabs.includes("staging") && (
          <TabsContent value="staging">
            <ManualStagingView ccy={account.currency} />
          </TabsContent>
        )}

        {/* Manual: Reconcile two-pane */}
        {visibleTabs.includes("reconcile") && (
          <TabsContent value="reconcile">
            <ManualReconcileView ccy={account.currency} />
          </TabsContent>
        )}

        {/* Approve-each: To approve cards */}
        {visibleTabs.includes("to-approve") && (
          <TabsContent value="to-approve" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Bank rows with suggested categories. One click commits to your ledger.
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

        {/* Auto-pilot: To categorize cards */}
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

        {/* Reconciled (all modes) */}
        <TabsContent value="reconciled" className="space-y-2">
          {lens === "auto" && accountData.reconciled.some((r) => r.resolvedBy === "rule") && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              <span>
                <span className="font-semibold text-amber-600 dark:text-amber-400">
                  {accountData.reconciled.filter((r) => r.resolvedBy === "rule").length} row(s) auto-applied by rules
                </span>{" "}
                <span className="text-muted-foreground">— click any row to inspect or override.</span>
              </span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Fully reconciled rows — in your bank ledger AND in your transaction history.
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
      </Tabs>

      {/* Upload drawer */}
      {uploadOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={() => setUploadOpen(false)} />
          <div className="fixed right-0 top-0 z-50 h-full w-full max-w-md border-l bg-background shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div>
                <h2 className="text-base font-semibold">Upload to {account.label}</h2>
                <p className="text-xs text-muted-foreground">Policy: {MODES[policy].label} · {MODES[policy].gates} gate{MODES[policy].gates !== 1 ? "s" : ""}</p>
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
              <div className={`rounded-md border px-3 py-2.5 text-xs ${MODES[policy].tone}`}>
                <p className="font-medium">After upload — {MODES[policy].label}:</p>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground list-disc pl-4">
                  {policy === "auto" && (
                    <>
                      <li>Matched rules → <span className="font-medium text-foreground">Reconciled</span></li>
                      <li>Unmatched → <span className="font-medium text-foreground">To categorize</span></li>
                    </>
                  )}
                  {policy === "approve" && <li>Rows land in <span className="font-medium text-foreground">To approve</span> with suggestions</li>}
                  {policy === "manual" && (
                    <>
                      <li>Rows land in <span className="font-medium text-foreground">Staging</span> two-pane for parse review</li>
                      <li>Approved rows move to <span className="font-medium text-foreground">Reconcile</span> two-pane</li>
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

      {/* Lens toast */}
      {lensToastVisible && (
        <LensToast
          lens={lens}
          accountLabel={`${account.label}`}
          onSave={onSavePolicy}
          onKeep={onKeepLens}
          onRevert={onRevertLens}
        />
      )}

      <footer className="pt-6 text-[11px] text-muted-foreground border-t mt-8 space-y-1">
        <p>
          v4 sandbox · <span className="font-medium">Manual mode = two panes</span>, <span className="font-medium">chip = lens (throwaway)</span>, <span className="font-medium">gear inside chip = policy (sticky)</span>.
        </p>
        <p>
          Try: pick Chequing (Auto policy), flip lens to Manual via chip — note the toast — accept rows, then revert. Switch to IBKR to see the two-pane native.
        </p>
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
