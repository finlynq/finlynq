"use client";

import { useState } from "react";
import {
  Check,
  Wallet,
  Upload,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  CreditCard,
  PiggyBank,
  TrendingUp,
  Building2,
  User,
  FileSpreadsheet,
  Database,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface OnboardingWizardProps {
  userEmail: string;
  displayName?: string;
  onComplete: () => void;
}

type Step = "welcome" | "profile" | "accounts" | "data" | "done";

const STEPS: Step[] = ["welcome", "profile", "accounts", "data", "done"];

const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  profile: "Profile",
  accounts: "Accounts",
  data: "Your data",
  done: "All set",
};

const ACCOUNT_PRESETS = [
  { name: "Checking Account", type: "A", group: "Checking", icon: Building2 },
  { name: "Savings Account", type: "A", group: "Savings", icon: PiggyBank },
  { name: "Credit Card", type: "L", group: "Credit Card", icon: CreditCard },
  { name: "Investment Account", type: "A", group: "Investments", icon: TrendingUp },
] as const;

const slideVariants = {
  enter: (d: number) => ({ x: d > 0 ? 80 : -80, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (d: number) => ({ x: d > 0 ? -80 : 80, opacity: 0 }),
};

export function OnboardingWizard({
  userEmail,
  displayName: initialName,
  onComplete,
}: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [direction, setDirection] = useState(1);
  const [displayName, setDisplayName] = useState(initialName || "");
  const [currency, setCurrency] = useState("CAD");
  const [selectedAccounts, setSelectedAccounts] = useState<number[]>([0]);
  const [dataChoice, setDataChoice] = useState<"demo" | "import" | "skip">("demo");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const stepIndex = STEPS.indexOf(step);

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

  function toggleAccount(idx: number) {
    setSelectedAccounts((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
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
          body: JSON.stringify({
            name: preset.name,
            type: preset.type,
            group: preset.group,
            currency,
          }),
        });
      }

      // Load demo data if selected
      if (dataChoice === "demo") {
        await fetch("/api/onboarding/sample-data", { method: "POST" });
      }

      // Save currency preference
      if (typeof window !== "undefined") {
        localStorage.setItem("pf-currency", currency);
      }

      // Mark onboarding complete
      await fetch("/api/onboarding/complete", { method: "POST" });

      setStep("done");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

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
                i <= stepIndex
                  ? "bg-foreground"
                  : "bg-muted"
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
        <div className="px-6 pb-6 min-h-[340px] flex flex-col">
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
                  <h2 className="text-2xl font-bold mb-2">
                    Welcome to Personal Finance
                  </h2>
                  <p className="text-muted-foreground max-w-sm">
                    Let&apos;s set up your account in a few quick steps. You&apos;ll
                    be tracking your finances in no time.
                  </p>
                </div>
              )}

              {/* ─── Profile ─────────────────────────────── */}
              {step === "profile" && (
                <div className="flex-1 flex flex-col py-6 gap-5">
                  <div className="flex items-center gap-3 mb-2">
                    <User className="h-6 w-6 text-muted-foreground" />
                    <h2 className="text-lg font-semibold">Your profile</h2>
                  </div>

                  <div>
                    <label className="text-sm font-medium" htmlFor="name">
                      Display name
                    </label>
                    <input
                      id="name"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Your name"
                      className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
                    />
                  </div>

                  <div>
                    <label className="text-sm font-medium" htmlFor="currency">
                      Default currency
                    </label>
                    <select
                      id="currency"
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      className="mt-1.5 w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
                    >
                      <option value="CAD">CAD — Canadian Dollar</option>
                      <option value="USD">USD — US Dollar</option>
                      <option value="EUR">EUR — Euro</option>
                      <option value="GBP">GBP — British Pound</option>
                    </select>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Signed in as {userEmail}
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
                    Pick the accounts you use. You can always add more later.
                  </p>
                  <div className="grid grid-cols-2 gap-3 mt-2">
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
                          <span className="text-sm font-medium leading-tight">
                            {preset.name}
                          </span>
                          {selected && (
                            <Check className="h-4 w-4 ml-auto text-emerald-500" />
                          )}
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
                    <h2 className="text-lg font-semibold">Get started with data</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    How would you like to begin?
                  </p>
                  <div className="space-y-3 mt-2">
                    {[
                      {
                        key: "demo" as const,
                        icon: Sparkles,
                        label: "Load sample data",
                        desc: "3 months of realistic transactions to explore features",
                      },
                      {
                        key: "import" as const,
                        icon: FileSpreadsheet,
                        label: "Import your data",
                        desc: "CSV, Excel, PDF, or OFX from your bank",
                      },
                      {
                        key: "skip" as const,
                        icon: ArrowRight,
                        label: "Start from scratch",
                        desc: "Add transactions manually as you go",
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
                      </button>
                    ))}
                  </div>
                  {error && (
                    <p className="text-sm text-destructive">{error}</p>
                  )}
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
                    Your account is ready. Head to the dashboard to start
                    tracking your finances.
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
            ) : step === "data" ? (
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
