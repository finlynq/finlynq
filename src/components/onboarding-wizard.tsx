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
  Landmark,
  ArrowRightLeft,
  Tags,
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
  | "categories"
  | "data"
  | "mcp"
  | "done";

const STEPS: Step[] = [
  "welcome",
  "currency",
  "accounts",
  "categories",
  "data",
  "mcp",
  "done",
];

const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  currency: "Currency",
  accounts: "Accounts",
  categories: "Categories",
  data: "Transactions",
  mcp: "Connect AI",
  done: "All set",
};

type DataChoice = "feed" | "import" | "migrate" | "skip";

/** Where the "All set" button sends the user for each way of starting. */
const DATA_DESTINATIONS: Record<DataChoice, { href: string | null; label: string; note: string }> = {
  feed: {
    href: "/settings/bank-feeds",
    label: "Connect my bank",
    note: "Next, connect your bank through SimpleFIN. New transactions will come in on their own.",
  },
  import: {
    href: "/import",
    label: "Go to Import",
    note: "Next, upload a statement from your bank. You'll review the rows before anything is saved.",
  },
  migrate: {
    href: "/settings/import?tab=migrate",
    label: "Move my data",
    note: "Next, bring your history over from the app you used before.",
  },
  skip: {
    href: null,
    label: "Go to Dashboard",
    note: "Your account is ready. Add transactions whenever you like, or import a statement later.",
  },
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

// A new account starts with no categories at all, so the wizard offers a
// small starter set. "Dividends" must be spelled exactly that: the dividend
// report finds the category by name.
const STARTER_CATEGORIES: Array<{ type: "I" | "E"; group: string; name: string }> = [
  { type: "I", group: "Income", name: "Salary" },
  { type: "I", group: "Income", name: "Interest" },
  { type: "I", group: "Income", name: "Dividends" },
  { type: "I", group: "Income", name: "Other income" },
  { type: "E", group: "Housing", name: "Rent or mortgage" },
  { type: "E", group: "Housing", name: "Utilities" },
  { type: "E", group: "Housing", name: "Internet and phone" },
  { type: "E", group: "Food", name: "Groceries" },
  { type: "E", group: "Food", name: "Dining out" },
  { type: "E", group: "Transport", name: "Transportation" },
  { type: "E", group: "Lifestyle", name: "Entertainment" },
  { type: "E", group: "Lifestyle", name: "Shopping" },
  { type: "E", group: "Lifestyle", name: "Subscriptions" },
  { type: "E", group: "Health", name: "Health and fitness" },
  { type: "E", group: "Other", name: "Gifts" },
  { type: "E", group: "Other", name: "Other" },
];

// Optional monthly budgets, left blank: a fixed amount means something
// different in every currency, so the user types their own or skips.
const BUDGET_CATEGORIES = ["Groceries", "Dining out", "Transportation", "Entertainment", "Utilities"];

const slideVariants = {
  enter: (d: number) => ({ x: d > 0 ? 80 : -80, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (d: number) => ({ x: d > 0 ? -80 : 80, opacity: 0 }),
};

export function OnboardingWizard({
  userEmail,
  displayName,
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
  const [dataChoice, setDataChoice] = useState<DataChoice>("import");
  const [addStarterCategories, setAddStarterCategories] = useState(true);
  const [budgetAmounts, setBudgetAmounts] = useState<Record<string, string>>({});
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
      // A 409 means the name already exists (e.g. Finish was pressed again
      // after an earlier attempt failed part-way), which is fine.
      const postOk = async (url: string, body: unknown) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return res.ok || res.status === 409;
      };

      // Categories first, so the budgets below attach to them.
      if (addStarterCategories) {
        for (const c of STARTER_CATEGORIES) {
          if (!(await postOk("/api/categories", c))) {
            throw new Error("Could not create your categories.");
          }
        }
      }

      for (const idx of selectedAccounts) {
        const preset = ACCOUNT_PRESETS[idx];
        const ok = await postOk("/api/accounts", {
          name: preset.name,
          type: preset.type,
          group: preset.group,
          currency,
          isInvestment: preset.isInvestment,
        });
        if (!ok) throw new Error(`Could not create "${preset.name}".`);
      }

      // Budgets for the current month, only for the amounts the user typed.
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM
      for (const categoryName of BUDGET_CATEGORIES) {
        const amount = Number(budgetAmounts[categoryName]);
        if (Number.isFinite(amount) && amount > 0) {
          await postOk("/api/budgets/seed", { categoryName, amount, month }).catch(() => false);
        }
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
    } catch (e) {
      setError(
        `${e instanceof Error && e.message ? e.message + " " : ""}Something went wrong. Please try again.`,
      );
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
        className="w-full max-w-lg mx-4 max-h-[92vh] overflow-y-auto rounded-2xl border bg-card shadow-2xl"
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
                    A few quick questions and you&apos;re ready: your currency, your accounts,
                    some categories, and how to bring in your transactions.
                  </p>
                  {(displayName || userEmail) && (
                    <p className="text-xs text-muted-foreground">
                      Signed in as {displayName || userEmail}
                    </p>
                  )}

                  <div className="flex items-center gap-4 sm:gap-6 mt-6 text-sm text-muted-foreground">
                    <div className="flex flex-col items-center gap-1.5">
                      <Wallet className="h-5 w-5" />
                      <span>Accounts</span>
                    </div>
                    <div className="text-muted-foreground/30">→</div>
                    <div className="flex flex-col items-center gap-1.5">
                      <Tags className="h-5 w-5" />
                      <span>Categories</span>
                    </div>
                    <div className="text-muted-foreground/30">→</div>
                    <div className="flex flex-col items-center gap-1.5">
                      <Upload className="h-5 w-5" />
                      <span>Transactions</span>
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

              {/* ─── Categories ──────────────────────────── */}
              {step === "categories" && (
                <div className="flex-1 flex flex-col py-6 gap-4">
                  <div className="flex items-center gap-3 mb-1">
                    <Tags className="h-6 w-6 text-muted-foreground" />
                    <h2 className="text-lg font-semibold">Categories</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Categories sort your income and spending. Start with this set, then
                    rename, merge or add your own anytime.
                  </p>

                  <label className="flex items-start gap-3 rounded-xl border-2 border-muted p-3.5 cursor-pointer transition-all hover:border-foreground/30">
                    <input
                      type="checkbox"
                      checked={addStarterCategories}
                      onChange={(e) => setAddStarterCategories(e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-foreground"
                    />
                    <span className="text-sm">
                      <span className="font-medium">Add starter categories</span>
                      <span className="mt-2 flex flex-wrap gap-1.5">
                        {STARTER_CATEGORIES.map((c) => (
                          <span
                            key={c.name}
                            className={`rounded-full border px-2 py-0.5 text-xs ${
                              c.type === "I"
                                ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                                : "text-muted-foreground"
                            }`}
                          >
                            {c.name}
                          </span>
                        ))}
                      </span>
                    </span>
                  </label>

                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Target className="h-4 w-4 text-muted-foreground" />
                      <p className="text-sm font-medium">Monthly budgets (optional)</p>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                      Type an amount in {currency} for any you want to track this month, or
                      leave them blank. You can set budgets later on the Budgets page.
                    </p>
                    <div className="space-y-2">
                      {BUDGET_CATEGORIES.map((category) => (
                        <div key={category} className="flex items-center gap-3">
                          <span className="w-32 text-sm shrink-0">{category}</span>
                          <div className="relative flex-1">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                              {currencySymbol}
                            </span>
                            <input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              step="any"
                              placeholder="No budget"
                              aria-label={`${category} monthly budget`}
                              value={budgetAmounts[category] ?? ""}
                              onChange={(e) =>
                                setBudgetAmounts((prev) => ({
                                  ...prev,
                                  [category]: e.target.value,
                                }))
                              }
                              className={`w-full rounded-lg border bg-background ${amountPadding} pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20`}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* ─── Transactions ───────────────────────────── */}
              {step === "data" && (
                <div className="flex-1 flex flex-col py-6 gap-4">
                  <div className="flex items-center gap-3 mb-1">
                    <Database className="h-6 w-6 text-muted-foreground" />
                    <h2 className="text-lg font-semibold">Bring in your transactions</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    How would you like to start? You can use any of these later too.
                  </p>
                  <div className="space-y-2.5 mt-1">
                    {[
                      {
                        key: "feed" as const,
                        icon: Landmark,
                        label: "Connect my bank",
                        desc: "New transactions arrive on their own through SimpleFIN, which works with many US and Canadian banks.",
                      },
                      {
                        key: "import" as const,
                        icon: FileSpreadsheet,
                        label: "Upload a statement",
                        desc: "A CSV, OFX, QFX, Excel or PDF file from your bank's website.",
                      },
                      {
                        key: "migrate" as const,
                        icon: ArrowRightLeft,
                        label: "Move from another app",
                        desc: "Bring your history over from Money Pro, WealthPosition, Interactive Brokers or a spreadsheet.",
                      },
                      {
                        key: "skip" as const,
                        icon: ArrowRight,
                        label: "Start from scratch",
                        desc: "Add transactions yourself, or ask your AI assistant to record them.",
                      },
                    ].map(({ key, icon: Icon, label, desc }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setDataChoice(key)}
                        className={`flex items-start gap-3 w-full rounded-xl border-2 p-3.5 text-left transition-all ${
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
                  <p className="text-xs text-muted-foreground">
                    Want to look around with sample data first? Sign out and choose{" "}
                    <span className="font-medium text-foreground">One-click demo</span> on the
                    sign-in page. The demo resets every night.
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
                    Ask Claude, ChatGPT, Gemini or another AI assistant about your money, and
                    have it record transactions for you. You sign in to Finlynq once to allow it.
                  </p>

                  <div className="rounded-xl border bg-muted/40 p-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <Terminal className="h-3.5 w-3.5" />
                      Server URL
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 rounded-lg bg-background border px-3 py-2 text-sm font-mono truncate">
                        {mcpUrl}
                      </code>
                      <button
                        type="button"
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
                    <p className="text-xs font-medium text-muted-foreground">Where to paste it:</p>
                    <ul className="text-sm text-muted-foreground space-y-1.5">
                      <li>
                        <span className="font-medium text-foreground">Claude:</span> Settings →
                        Connectors → Add custom connector
                      </li>
                      <li>
                        <span className="font-medium text-foreground">ChatGPT:</span> Settings →
                        Apps → Advanced settings (turn on developer mode), then Create app
                      </li>
                      <li>
                        <span className="font-medium text-foreground">Gemini:</span> Settings →
                        Connected apps → Custom apps
                      </li>
                    </ul>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Steps for Cursor, Gemini CLI and others are in the{" "}
                    <a
                      href="/connect"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      connection guide
                    </a>
                    . You can skip this and connect later from the sidebar.
                  </p>

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
                    {DATA_DESTINATIONS[dataChoice].note}
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
                  const href = DATA_DESTINATIONS[dataChoice].href;
                  if (href) {
                    window.location.href = href;
                  } else {
                    onComplete();
                  }
                }}
                className="ml-auto flex items-center gap-2 rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90 transition-opacity"
              >
                {DATA_DESTINATIONS[dataChoice].label}
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
