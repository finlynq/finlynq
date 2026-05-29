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
  ChevronDown,
  Trash2,
} from "lucide-react";

type MockRow = {
  id: string;
  date: string;
  payee: string;
  amount: number;
  suggestion:
    | { kind: "match"; tx: string; category: string }
    | { kind: "create"; category: string }
    | { kind: "transfer"; counter: string; amount: number }
    | { kind: "rule"; ruleName: string; category: string }
    | { kind: "none" };
};

const MOCK_ACCOUNTS = [
  { id: "chq", label: "Chequing", currency: "CAD", balanceBank: 4128.32, balanceFlq: 4128.32 },
  { id: "vis", label: "Visa Rewards", currency: "CAD", balanceBank: -842.17, balanceFlq: -842.17 },
  { id: "sav", label: "High-Interest Savings", currency: "CAD", balanceBank: 18450.0, balanceFlq: 18450.0 },
];

const MOCK_NEEDS_REVIEW: MockRow[] = [
  {
    id: "n1",
    date: "2026-05-26",
    payee: "Metro",
    amount: -113.47,
    suggestion: { kind: "match", tx: "tx #4821 · Metro · Groceries", category: "Groceries" },
  },
  {
    id: "n2",
    date: "2026-05-25",
    payee: "PAI NORTHERN",
    amount: -38.26,
    suggestion: { kind: "create", category: "Restaurants" },
  },
  {
    id: "n3",
    date: "2026-05-25",
    payee: "E-TRANSFER FROM SAVINGS",
    amount: 500.0,
    suggestion: { kind: "transfer", counter: "High-Interest Savings", amount: -500 },
  },
  {
    id: "n4",
    date: "2026-05-24",
    payee: "AMZ*MARKETPLACE",
    amount: -54.92,
    suggestion: { kind: "rule", ruleName: "Amazon → Shopping", category: "Shopping" },
  },
  {
    id: "n5",
    date: "2026-05-24",
    payee: "PHANTOM COFFEE",
    amount: -8.5,
    suggestion: { kind: "none" },
  },
];

const MOCK_TO_CATEGORIZE: MockRow[] = [
  {
    id: "c1",
    date: "2026-05-23",
    payee: "LOBLAWS",
    amount: -67.12,
    suggestion: { kind: "create", category: "Groceries" },
  },
  {
    id: "c2",
    date: "2026-05-22",
    payee: "SHELL #4421",
    amount: -64.0,
    suggestion: { kind: "create", category: "Transportation" },
  },
];

const MOCK_DONE: MockRow[] = [
  {
    id: "d1",
    date: "2026-05-21",
    payee: "Starbucks",
    amount: -6.5,
    suggestion: { kind: "match", tx: "tx #4801 · Starbucks · Coffee", category: "Coffee" },
  },
  {
    id: "d2",
    date: "2026-05-20",
    payee: "Payroll",
    amount: 3214.0,
    suggestion: { kind: "match", tx: "tx #4799 · Payroll · Income", category: "Salary" },
  },
];

function fmtCurrency(n: number, ccy = "CAD") {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)} ${ccy === "CAD" ? "" : ccy}`.trim();
}

function SuggestionPill({ row }: { row: MockRow }) {
  const s = row.suggestion;
  if (s.kind === "match") {
    return (
      <div className="flex items-center gap-2 text-xs">
        <Link2 className="h-3.5 w-3.5 text-sky-500" />
        <span className="text-muted-foreground">suggested:</span>
        <span className="font-medium">match</span>
        <span className="text-muted-foreground">{s.tx}</span>
      </div>
    );
  }
  if (s.kind === "create") {
    return (
      <div className="flex items-center gap-2 text-xs">
        <Plus className="h-3.5 w-3.5 text-emerald-500" />
        <span className="text-muted-foreground">suggested:</span>
        <span className="font-medium">create as</span>
        <Badge variant="secondary" className="font-mono text-[10px]">{s.category}</Badge>
      </div>
    );
  }
  if (s.kind === "transfer") {
    return (
      <div className="flex items-center gap-2 text-xs">
        <ArrowLeftRight className="h-3.5 w-3.5 text-indigo-500" />
        <span className="text-muted-foreground">suggested:</span>
        <span className="font-medium">transfer</span>
        <span className="text-muted-foreground">↔ {s.counter} ({fmtCurrency(s.amount)})</span>
      </div>
    );
  }
  if (s.kind === "rule") {
    return (
      <div className="flex items-center gap-2 text-xs">
        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-muted-foreground">rule fired:</span>
        <span className="font-medium">{s.ruleName}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground italic">
      no match — needs your decision
    </div>
  );
}

function MockRowCard({
  row,
  onAccept,
  onDismiss,
}: {
  row: MockRow;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="rounded-lg border bg-card transition-shadow hover:shadow-sm">
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
            <SuggestionPill row={row} />
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {row.suggestion.kind !== "none" ? (
            <Button size="sm" className="h-7 gap-1" onClick={() => onAccept(row.id)}>
              <Check className="h-3.5 w-3.5" /> OK
            </Button>
          ) : (
            <Button size="sm" variant="secondary" className="h-7 gap-1">
              <Plus className="h-3.5 w-3.5" /> Create
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={() => setEditing((e) => !e)}
            aria-label="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-500"
            onClick={() => onDismiss(row.id)}
            aria-label="Delete"
          >
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
              <Input defaultValue={row.suggestion.kind === "create" || row.suggestion.kind === "match" || row.suggestion.kind === "rule" ? (row.suggestion as { category: string }).category : ""} className="h-8" />
            </div>
            <div className="space-y-1 col-span-2">
              <label className="text-xs text-muted-foreground">Link to existing transaction</label>
              <Input placeholder="Search transactions…" className="h-8" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" className="h-7" onClick={() => { setEditing(false); onAccept(row.id); }}>Save</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function UploadDrawer({
  open,
  onClose,
  accountLabel,
}: {
  open: boolean;
  onClose: () => void;
  accountLabel: string;
}) {
  if (!open) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="fixed right-0 top-0 z-50 h-full w-full max-w-md border-l bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Upload to {accountLabel}</h2>
            <p className="text-xs text-muted-foreground">CSV · OFX · QFX · XML</p>
          </div>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-5 space-y-5">
          <div className="rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/20 px-6 py-10 text-center">
            <Upload className="mx-auto h-7 w-7 text-muted-foreground/60" />
            <p className="mt-2 text-sm font-medium">Drop file here</p>
            <p className="text-xs text-muted-foreground">or click to browse</p>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Template</label>
            <div className="space-y-1.5">
              {[
                { id: "auto", label: "Auto-detect", desc: "Let Finlynq pick the best template" },
                { id: "rbc-d", label: "RBC Chequing — Detailed", desc: "Stages to Needs review" },
                { id: "rbc-s", label: "RBC Chequing — Simplified", desc: "Lands directly in To categorize" },
              ].map((t, i) => (
                <label key={t.id} className="flex items-start gap-3 rounded-md border bg-card px-3 py-2.5 cursor-pointer hover:bg-muted/50">
                  <input type="radio" name="tpl" defaultChecked={i === 1} className="mt-1" />
                  <div className="flex-1">
                    <div className="text-sm font-medium">{t.label}</div>
                    <div className="text-xs text-muted-foreground">{t.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div className="rounded-md bg-sky-500/10 border border-sky-500/30 px-3 py-2.5 text-xs text-sky-700 dark:text-sky-300">
            After upload, rows will land in <span className="font-medium">Needs review</span> for the Detailed template, or directly in <span className="font-medium">To categorize</span> for Simplified.
          </div>
        </div>
        <div className="absolute bottom-0 left-0 right-0 border-t bg-background px-5 py-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm">Upload</Button>
        </div>
      </div>
    </>
  );
}

export default function ReconcileV2Preview() {
  const [accountId, setAccountId] = useState("chq");
  const [tab, setTab] = useState("needs-review");
  const [uploadOpen, setUploadOpen] = useState(false);

  const [needsReview, setNeedsReview] = useState(MOCK_NEEDS_REVIEW);
  const [toCategorize, setToCategorize] = useState(MOCK_TO_CATEGORIZE);
  const [done, setDone] = useState(MOCK_DONE);

  const account = MOCK_ACCOUNTS.find((a) => a.id === accountId)!;
  const balanceDelta = account.balanceBank - account.balanceFlq;
  const balanced = Math.round(balanceDelta * 100) === 0;

  const acceptFromNeedsReview = (id: string) => {
    const row = needsReview.find((r) => r.id === id);
    if (!row) return;
    setNeedsReview((rows) => rows.filter((r) => r.id !== id));
    setToCategorize((rows) => [{ ...row }, ...rows]);
  };
  const acceptFromToCategorize = (id: string) => {
    const row = toCategorize.find((r) => r.id === id);
    if (!row) return;
    setToCategorize((rows) => rows.filter((r) => r.id !== id));
    setDone((rows) => [{ ...row }, ...rows]);
  };
  const dismiss = (id: string) => {
    setNeedsReview((rows) => rows.filter((r) => r.id !== id));
    setToCategorize((rows) => rows.filter((r) => r.id !== id));
    setDone((rows) => rows.filter((r) => r.id !== id));
  };

  const acceptAllSuggested = () => {
    needsReview.filter((r) => r.suggestion.kind !== "none").forEach((r) => acceptFromNeedsReview(r.id));
  };

  const counts = useMemo(
    () => ({
      needsReview: needsReview.length,
      toCategorize: toCategorize.length,
      done: done.length,
    }),
    [needsReview, toCategorize, done]
  );

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Reconcile</h1>
            <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider">Preview v2</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            One account-scoped inbox. Pick an account, work through what needs your attention.
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

      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Account</span>
            <Select value={accountId} onValueChange={(v) => setAccountId(v ?? "chq")}>
              <SelectTrigger className="w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MOCK_ACCOUNTS.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label} · {a.currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="flex items-center gap-6 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Bank says</div>
              <div className="font-mono">{fmtCurrency(account.balanceBank, account.currency)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Finlynq has</div>
              <div className="font-mono">{fmtCurrency(account.balanceFlq, account.currency)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Δ</div>
              <div className={`font-mono ${balanced ? "text-emerald-500" : "text-amber-500"}`}>
                {fmtCurrency(balanceDelta, account.currency)} {balanced ? "✓" : ""}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="gap-4">
        <TabsList className="h-9">
          <TabsTrigger value="needs-review" className="gap-2">
            Needs review
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">{counts.needsReview}</Badge>
          </TabsTrigger>
          <TabsTrigger value="to-categorize" className="gap-2">
            To categorize
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">{counts.toCategorize}</Badge>
          </TabsTrigger>
          <TabsTrigger value="done" className="gap-2">
            Done
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-mono">{counts.done}</Badge>
          </TabsTrigger>
          <TabsTrigger value="advanced" className="gap-2">
            Advanced
          </TabsTrigger>
        </TabsList>

        <TabsContent value="needs-review" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Newly uploaded or feed rows waiting for a decision. Accept the suggestion or edit before approving.
            </p>
            {needsReview.some((r) => r.suggestion.kind !== "none") && (
              <Button size="sm" variant="outline" className="gap-1.5 h-7" onClick={acceptAllSuggested}>
                <Sparkles className="h-3.5 w-3.5" /> Accept all suggested ({needsReview.filter((r) => r.suggestion.kind !== "none").length})
              </Button>
            )}
          </div>
          {needsReview.length === 0 ? (
            <EmptyState label="Nothing to review — fresh as a daisy." />
          ) : (
            <div className="space-y-1.5">
              {needsReview.map((r) => (
                <MockRowCard
                  key={r.id}
                  row={r}
                  onAccept={acceptFromNeedsReview}
                  onDismiss={dismiss}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="to-categorize" className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Approved bank rows still needing a category or a link to an existing transaction.
          </p>
          {toCategorize.length === 0 ? (
            <EmptyState label="Nothing left to categorize on this account." />
          ) : (
            <div className="space-y-1.5">
              {toCategorize.map((r) => (
                <MockRowCard
                  key={r.id}
                  row={r}
                  onAccept={acceptFromToCategorize}
                  onDismiss={dismiss}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="done" className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Fully reconciled rows. Read-only — click a row to view it on the transactions page.
          </p>
          {done.length === 0 ? (
            <EmptyState label="Nothing reconciled yet on this account." />
          ) : (
            <div className="space-y-1.5">
              {done.map((r) => (
                <div key={r.id} className="rounded-lg border bg-muted/20 px-4 py-2.5 opacity-80">
                  <div className="flex items-baseline gap-3">
                    <span className="text-xs font-mono text-muted-foreground">{r.date}</span>
                    <span className="text-sm">{r.payee}</span>
                    <span className={`ml-auto text-sm font-mono ${r.amount < 0 ? "text-rose-500" : "text-emerald-500"}`}>
                      {fmtCurrency(r.amount)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="advanced" className="space-y-3">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
            <span className="font-semibold">Advanced mode</span> — for messy reconciles. This is where the existing two-pane + checkbox + N×M bulk-link UX would live. Drop into this view when the default row+suggestion pattern can&apos;t handle a case (e.g. 3 transactions ↔ 1 bank deposit). Today this is the entire <code>/reconcile</code> page.
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transactions</h3>
                <Badge variant="outline" className="text-[10px]">47</Badge>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground italic">
                (Current TransactionsPane component drops in here unchanged.)
              </div>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bank ledger</h3>
                <Badge variant="outline" className="text-[10px]">52</Badge>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground italic">
                (Current BankPane component drops in here unchanged.)
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <UploadDrawer
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        accountLabel={`${account.label} · ${account.currency}`}
      />

      <footer className="pt-6 text-[11px] text-muted-foreground border-t mt-8 flex items-center justify-between flex-wrap gap-2">
        <div>
          Preview sandbox · not wired to APIs · existing pages at <code>/import</code>, <code>/import/pending</code>, <code>/reconcile</code> still work
        </div>
        <div className="flex items-center gap-1">
          <ChevronDown className="h-3 w-3" />
          Tab data resets on refresh
        </div>
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
