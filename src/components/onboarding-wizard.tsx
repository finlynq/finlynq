"use client";

import { useState } from "react";
import { currencyLabel } from "@/lib/fx/supported-currencies";
import { Combobox } from "@/components/ui/combobox";
import { useDisplayCurrencyOptions } from "@/lib/hooks/useDisplayCurrencyOptions";
import { formatCurrency } from "@/lib/currency";
import { useDisplayCurrency } from "@/components/currency-provider";
import {
  Check,
  Coins,
  Wallet,
  Upload,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  CreditCard,
  PiggyBank,
  TrendingUp,
  Building2,
  FileSpreadsheet,
  Database,
  Bot,
  Target,
  Terminal,
  Copy,
  CheckCheck,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface OnboardingWizardProps {
  userEmail: string;
  displayName?: string;
  onComplete: () => void;
}

type Step =
  | "welcome"
  | "currency"
  | "accounts"
  | "data"
  | "budget"
  | "mcp"
  | "done";

const STEPS: Step[] = [
  "welcome",
  "currency",
  "accounts",
  "data",
  "budget",
  "mcp",
  "done",
];

const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  currency: "Currency",
  accounts: "Accounts",
  data: "Import",
  budget: "Budget",
  mcp: "Connect AI",
  done: "All set",
};

const ACCOUNT_PRESETS = [
  { name: "Checking Account", type: "A", group: "Checking", icon: Building2, isInvestment: false },
  { name: "Savings Account", type: "A", group: "Savings", icon: PiggyBank, isInvestment: false },
  { name: "Credit Card", type: "L", group: "Credit Card", icon: CreditCard, isInvestment: false },
  // GH #308 — the "Investment Account" preset MUST set is_investment=true, else
  // it creates a plain cash account grouped "Investments" whose portfolio /
  // market-basis features silently never apply.
  { name: "Investment Account", type: "A", group: "Investments", icon: TrendingUp, isInvestment: true },
] as const;

const BUDGET_PRESETS = [
  { category: "Groceries", amount: 600 },
  { category: "Dining Out", amount: 300 },
  { category: "Transportation", amount: 200 },
  { category: "Entertainment", amount: 150 },
  { category: "Utilities", amount: 150 },
];

const slideVariants = {
  enter: (d: number) => ({ x: d > 0 ? 80 : -80, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (d: number) => ({ x: d > 0 ? -80 : 80, opacity: 0 }),
};

export function OnboardingWizard({
  userEmail,
  displayName: _displayName,
  onComplete,
}: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [direction, setDirection] = useState(1);
  // Default to USD when the user has no display currency yet (the app-wide
  // default per FINLYNQ-183). FINLYNQ-300: this answer is persisted to
  // settings.display_currency on finish — no longer thrown into a dead
  // localStorage key.
  //
  // This IS the reporting-currency question the `display_currency` decision
  // prompt asks; onboarding owns it for new users and the gate stays silent
  // until onboarding completes (see src/lib/prompts/resolve.ts). It gets its own
  // step so it reads as an app-wide decision rather than a field above the
  // account tiles, and stays reachable via Back for the rest of the wizard.
  const [currency, setCurrency] = useState("USD");
  // The provider's setter — updates the app-wide context AND persists.
  const { setDisplayCurrency: persistDisplayCurrency } = useDisplayCurrency();
  const currencyOptions = useDisplayCurrencyOptions(currency);
  const [selectedAccounts, setSelectedAccounts] = useState<number[]>([0]);
  const [dataChoice, setDataChoice] = useState<"demo" | "import" | "skip">("import");
  const [budgetAmounts, setBudgetAmounts] = useState<Record<string, number>>(
    Object.fromEntries(BUDGET_PRESETS.map((p) => [p.category, p.amount]))
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const stepIndex = STEPS.indexOf(step);
  // Derive the currency symbol from the single source of truth (formatCurrency /
  // DOLLAR_SYMBOLS) instead of a hardcoded ternary — strip digits/separators.
  const currencySymbol =
    formatCurrency(0, currency, { decimals: 0 }).replace(/[\d\s.,]/g, "") || "$";
  // Symbols are not all one character — `$` and `€` are, but `C$` is two and
  // `JP¥` / `CHF` are three, and the budget inputs below overlay the symbol on
  // the field. A fixed `pl-7` sized for `$` made JPY render as "JP¥600" with the
  // symbol sitting on top of the amount. Only reachable since the currency list
  // widened past USD/CAD, so scale the padding with the symbol instead.
  const amountPadding =
    currencySymbol.length >= 3 ? "pl-12" : currencySymbol.length === 2 ? "pl-9" : "pl-7";

  function goNext() {
    setDirection(1);
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next);
  }

  function goBack() {
    setDirection(-1);
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  }

  /** Jump to a step by name — the Accounts step's "Change" currency link. */
  function goTo(target: Step) {
    setDirection(STEPS.indexOf(target) > stepIndex ? 1 : -1);
    setStep(target);
  }

  function toggleAccount(idx: number) {
    setSelectedAccounts((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  }

  function copyMcpUrl() {
    navigator.clipboard.writeText(window.location.origin + "/api/mcp").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleFinish() {
    setLoading(true);
    setError("");

    try {
      // Create selected accounts
      for (const idx of selectedAccounts) {
        const preset = ACCOUNT_PRESETS[idx];
        await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: preset.name, type: preset.type, group: preset.group, currency, isInvestment: preset.isInvestment }),
        });
      }

      // Create budgets for current month
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM
      for (const [categoryName, amount] of Object.entries(budgetAmounts)) {
        if (amount > 0) {
          await fetch("/api/budgets/seed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ categoryName, amount, month }),
          }).catch(() => {/* ignore */});
        }
      }

      // Load demo data if selected
      if (dataChoice === "demo") {
        await fetch("/api/onboarding/sample-data", { method: "POST" });
      }

      // Persist the chosen display currency to settings.display_currency
      // (FINLYNQ-300) — the wizard used to throw this into a dead localStorage
      // key the app never read. Must land BEFORE onboarding is marked complete
      // so the dashboard/totals render in the right currency.
      //
      // Goes through the CurrencyProvider's setter, NOT a raw PUT to the same
      // route: the provider reads the currency once from `/api/auth/session` at
      // mount, which for a brand-new user is the USD default (no settings row
      // yet). A bare PUT persists the choice but leaves that context stale, so
      // the whole app — including Settings → Display Currency — kept rendering
      // USD after the user picked EUR, until a hard reload. The setter updates
      // the context and PUTs the same endpoint.
      await persistDisplayCurrency(currency).catch(() => {
        /* non-fatal — settings fall back to the USD default */
      });

      // Mark onboarding complete
      await fetch("/api/onboarding/complete", { method: "POST" });

      setStep("done");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const mcpUrl = typeof window !== "undefined"
    ? window.location.origin + "/api/mcp"
    : "http://localhost:3000/api/mcp";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="w-full max-w-lg mx-4 rounded-2xl border bg-card shadow-2xl overflow-hidden"
      >
        {/* Progress */}
        <div className="flex gap-1 px-6 pt-6">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= stepIndex ? "bg-foreground" : "bg-muted"
              }`}
            />
          ))}
        </div>

        {/* Step label */}
        <div className="px-6 pt-3">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            Step {stepIndex + 1} of {STEPS.length} — {STEP_LABELS[step]}
          </p>
        </div>

        {/* Content */}
        <div className="px-6 pb-6 min-h-[360px] flex flex-col">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="flex-1 flex flex-col"
            >
              {/* ─── Welcome ─────────────────────────────── */}
              {step === "welcome" && (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ delay: 0.15, type: "spring", stiffness: 200 }}
                  >
                    <Sparkles className="h-14 w-14 text-amber-500 mb-4" />
                  </motion.div>
                  <h2 className="text-2xl font-bold mb-2">Welcome to Finlynq</h2>
                  <p className="text-muted-foreground max-w-sm mb-4">
                    Let&apos;s get you set up in 6 steps. You&apos;ll be tracking your finances and
                    querying them with your AI in under 10 minutes.
                  </p>
                  <p className="text-xs text-muted-foreground">Signed in as {userEmail}</p>

                  <div className="flex items-center gap-6 mt-6 text-sm text-muted-foreground">
                    <div className="flex flex-col items-center gap-1.5">
                      <Wallet className="h-5 w-5" />
                      <span>Accounts</span>
                    </div>
                    <div className="text-muted-foreground/30">→</div>
                    <div className="flex flex-col items-center gap-1.5">
                      <Upload className="h-5 w-5" />
                      <span>Import</span>
                    </div>
                    <div className="text-muted-foreground/30">→</div>
                    <div className="flex flex-col items-center gap-1.5">
                      <Target className="h-5 w-5" />
                      <span>Budget</span>
                    </div>
                    <div className="text-muted-foreground/30">→</div>
                    <div className="flex flex-col items-center gap-1.5">
                      <Bot className="h-5 w-5" />
                      <span>AI</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ─── Currency ────────────────────────────── */}
              {step === "currency" && (
                <div className="flex-1 flex flex-col py-6 gap-4">
                  <div className="flex items-center gap-3 mb-1">
                    <Coins className="h-6 w-6 text-muted-foreground" />
                    <h2 className="text-lg font-semibold">
                      Which currency should we show your money in?
                    </h2>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    We report every total in one currency. Individual accounts and
                    transactions keep their own — you can change this anytime in
                    Settings.
                  </p>

                  <div>
                    <label className="text-sm font-medium" htmlFor="currency">
                      Reporting currency
                    </label>
                    <div className="mt-1.5">
                      <Combobox
                        value={currency}
                        onValueChange={(v) => setCurrency(v || "USD")}
                        items={currencyOptions}
                        placeholder="Select currency"
                        searchPlaceholder="Search currencies…"
                        emptyMessage="No matching currency"
                      />
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Totals like net worth and monthly spending are converted to{" "}
                    {currency}. The accounts you add next start in this currency.
                  </p>
                </div>
              )}

              {/* ─── Accounts ────────────────────────────── */}
              {step === "accounts" && (
                <div className="flex-1 flex flex-col py-6 gap-4">
                  <div className="flex items-center gap-3 mb-1">
                    <Wallet className="h-6 w-6 text-muted-foreground" />
                    <h2 className="text-lg font-semibold">Add accounts</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Pick the accounts you use. You can add more later.
                  </p>

                  {/* The currency lives on its own step now — echo it here so
                      the choice stays visible (and changeable) instead of
                      disappearing once the wizard moves on. */}
                  <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">
                      Created in{" "}
                      <span className="font-medium text-foreground">
                        {currency} — {currencyLabel(currency)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => goTo("currency")}
                      className="text-xs font-medium underline underline-offset-2 hover:text-foreground text-muted-foreground"
                    >
                      Change
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3 mt-1">
                    {ACCOUNT_PRESETS.map((preset, idx) => {
                      const Icon = preset.icon;
                      const selected = selectedAccounts.includes(idx);
                      return (
                        <button
                          key={preset.name}
                          onClick={() => toggleAccount(idx)}
                          className={`flex items-center gap-3 rounded-xl border-2 p-3.5 text-left transition-all ${
                            selected
                              ? "border-foreground bg-foreground/5"
                              : "border-muted hover:border-foreground/30"
                          }`}
                        >
                          <Icon className="h-5 w-5 shrink-0" />
                          <span className="text-sm font-medium leading-tight">{preset.name}</span>
                          {selected && <Check className="h-4 w-4 ml-auto text-emerald-500" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ─── Data ────────────────────────────────── */}
              {step === "data" && (
                <div className="flex-1 flex flex-col py-6 gap-4">
                  <div className="flex items-center gap-3 mb-1">
                    <Database className="h-6 w-6 text-muted-foreground" />
                    <h2 className="text-lg font-semibold">Import your data</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    How would you like to start?
                  </p>
                  <div className="space-y-3 mt-2">
                    {[
                      {
                        key: "import" as const,
                        icon: FileSpreadsheet,
                        label: "Import from my bank",
                        desc: "Upload a CSV or OFX file — takes about 2 minutes",
                      },
                      {
                        key: "demo" as const,
                        icon: Sparkles,
                        label: "Load sample data",
                        desc: "3 months of realistic transactions to explore features",
                      },
                      {
                        key: "skip" as const,
                        icon: ArrowRight,
                        label: "Start from scratch",
                        desc: "Add transactions manually, import later",
                      },
                    ].map(({ key, icon: Icon, label, desc }) => (
                      <button
                        key={key}
                        onClick={() => setDataChoice(key)}
                        className={`flex items-start gap-3 w-full rounded-xl border-2 p-4 text-left transition-all ${
                          dataChoice === key
                            ? "border-foreground bg-foreground/5"
                            : "border-muted hover:border-foreground/30"
                        }`}
                      >
                        <Icon className="h-5 w-5 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-sm font-medium">{label}</p>
                          <p className="text-xs text-muted-foreground">{desc}</p>
                        </div>
                        {dataChoice === key && (
                          <Check className="h-4 w-4 ml-auto mt-0.5 text-emerald-500 shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ─── Budget ───────────────────────────────── */}
              {step === "budget" && (
                <div className="flex-1 flex flex-col py-6 gap-4">
                  <div className="flex items-center gap-3 mb-1">
                    <Target className="h-6 w-6 text-muted-foreground" />
                    <h2 className="text-lg font-semibold">Set a starter budget</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Adjust these monthly amounts to match your spending. You can fine-tune anytime.
                  </p>
                  <div className="space-y-3 mt-1">
                    {BUDGET_PRESETS.map(({ category }) => (
                      <div key={category} className="flex items-center gap-3">
                        <span className="w-36 text-sm font-medium shrink-0">{category}</span>
                        <div className="relative flex-1">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                            {currencySymbol}
                          </span>
                          <input
                            type="number"
                            min={0}
                            step={10}
                            value={budgetAmounts[category]}
                            onChange={(e) =>
                              setBudgetAmounts((prev) => ({
                                ...prev,
                                [category]: Number(e.target.value),
                              }))
                            }
                            className={`w-full rounded-lg border bg-background ${amountPadding} pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    These budgets will be created for the current month.
                  </p>
                </div>
              )}

              {/* ─── MCP ─────────────────────────────────── */}
              {step === "mcp" && (
                <div className="flex-1 flex flex-col py-6 gap-4">
                  <div className="flex items-center gap-3 mb-1">
                    <Bot className="h-6 w-6 text-muted-foreground" />
                    <h2 className="text-lg font-semibold">Connect your AI assistant</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    The MCP server lets Claude, Cursor, or any AI client query your financial data
                    using natural language — no manual exports needed.
                  </p>

                  <div className="rounded-xl border bg-muted/40 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <Terminal className="h-3.5 w-3.5" />
                      MCP Server URL
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 rounded-lg bg-background border px-3 py-2 text-sm font-mono truncate">
                        {mcpUrl}
                      </code>
                      <button
                        onClick={copyMcpUrl}
                        className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-muted transition-colors shrink-0"
                      >
                        {copied ? (
                          <CheckCheck className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                        {copied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Quick setup:</p>
                    <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
                      <li>Copy the URL above</li>
                      <li>Open Claude Desktop → Settings → MCP Servers</li>
                      <li>Add a new server with the URL</li>
                      <li>Ask Claude anything about your finances!</li>
                    </ol>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-xs">?</span>
                    Full setup guide for Cursor, Cline &amp; others on the MCP Guide page.
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}

              {/* ─── Done ────────────────────────────────── */}
              {step === "done" && (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 200 }}
                    className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15 mb-4"
                  >
                    <Check className="h-8 w-8 text-emerald-500" />
                  </motion.div>
                  <h2 className="text-2xl font-bold mb-2">You&apos;re all set!</h2>
                  <p className="text-muted-foreground max-w-sm">
                    {dataChoice === "import"
                      ? "Head to the Import page to upload your bank statement, then come back to see your data."
                      : "Your account is ready. Head to the dashboard to start tracking your finances."}
                  </p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Footer buttons */}
          <div className="flex justify-between items-center pt-4 mt-auto">
            {stepIndex > 0 && step !== "done" ? (
              <button
                onClick={goBack}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
            ) : (
              <div />
            )}

            {step === "done" ? (
              <button
                onClick={() => {
                  if (dataChoice === "import") {
                    window.location.href = "/import";
                  } else {
                    onComplete();
                  }
                }}
                className="ml-auto flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90 transition-opacity"
              >
                {dataChoice === "import" ? "Go to Import" : "Go to Dashboard"}
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : step === "budget" ? (
              <button
                onClick={goNext}
                className="ml-auto flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90 transition-opacity"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : step === "mcp" ? (
              <button
                onClick={handleFinish}
                disabled={loading}
                className="ml-auto flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {loading ? "Setting up..." : "Finish Setup"}
                {!loading && <Check className="h-4 w-4" />}
              </button>
            ) : (
              <button
                onClick={goNext}
                className="ml-auto flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90 transition-opacity"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
