"use client";

import { useState } from "react";
import {
  Shield,
  Lock,
  Eye,
  EyeOff,
  FolderOpen,
  AlertTriangle,
  Check,
  Wallet,
  Upload,
  Database,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  CreditCard,
  PiggyBank,
  TrendingUp,
  Building2,
  HelpCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface SetupWizardProps {
  hasExistingData: boolean;
  onComplete: () => void;
}

type Step = "welcome" | "password" | "storage" | "account" | "import" | "done";

const STEPS: Step[] = ["welcome", "password", "storage", "account", "import", "done"];

const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  password: "Password",
  storage: "Storage",
  account: "Account",
  import: "Your data",
  done: "All set",
};

interface Tip {
  text: string;
  visible: boolean;
}

function Tooltip({ text, visible }: Tip) {
  if (!visible) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      className="mt-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 px-3 py-2"
    >
      <div className="flex gap-2 items-start">
        <HelpCircle className="h-3.5 w-3.5 text-indigo-500 mt-0.5 shrink-0" />
        <p className="text-xs text-indigo-700 dark:text-indigo-300">{text}</p>
      </div>
    </motion.div>
  );
}

function getStrength(pw: string): { label: string; color: string; width: string } {
  if (pw.length < 8) return { label: "Too short", color: "bg-rose-500", width: "w-1/5" };
  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: "Weak", color: "bg-rose-500", width: "w-2/5" };
  if (score <= 2) return { label: "Fair", color: "bg-amber-500", width: "w-3/5" };
  if (score <= 3) return { label: "Good", color: "bg-emerald-500", width: "w-4/5" };
  return { label: "Strong", color: "bg-emerald-500", width: "w-full" };
}

const ACCOUNT_PRESETS = [
  { name: "Checking Account", type: "A", group: "Checking", icon: Building2 },
  { name: "Savings Account", type: "A", group: "Savings", icon: PiggyBank },
  { name: "Credit Card", type: "L", group: "Credit Card", icon: CreditCard },
  { name: "Investment Account", type: "A", group: "Investments", icon: TrendingUp },
] as const;

export function SetupWizard({ hasExistingData, onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [dbPath, setDbPath] = useState("");
  const [mode, setMode] = useState<"local" | "cloud">("local");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState<number[]>([0]); // Checking selected by default
  const [customAccountName, setCustomAccountName] = useState("");
  const [importChoice, setImportChoice] = useState<"demo" | "import" | "skip">("demo");
  const [setupDone, setSetupDone] = useState(false);
  const [tipVisible, setTipVisible] = useState<Record<string, boolean>>({});

  const strength = getStrength(passphrase);
  const passwordMatch = passphrase === confirmPassphrase && passphrase.length >= 8;
  const stepIndex = STEPS.indexOf(step);

  function toggleTip(key: string) {
    setTipVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function toggleAccount(idx: number) {
    setSelectedAccounts((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  }

  function goNext() {
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next);
  }

  function goBack() {
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  }

  async function handleSetupEncryption() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setup",
          passphrase,
          dbPath: dbPath || undefined,
          mode,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Setup failed. Please try again.");
        return;
      }
      // Encryption done — proceed to account step
      goNext();
    } catch {
      setError("Could not connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateAccounts() {
    setLoading(true);
    setError("");
    try {
      const accountsToCreate = selectedAccounts.map((idx) => ACCOUNT_PRESETS[idx]);
      const extra = customAccountName.trim();

      for (const acct of accountsToCreate) {
        await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: acct.name,
            type: acct.type,
            group: acct.group,
            currency: "CAD",
          }),
        });
      }

      if (extra) {
        await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: extra,
            type: "A",
            group: "Checking",
            currency: "CAD",
          }),
        });
      }

      goNext();
    } catch {
      setError("Could not create accounts. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleFinish() {
    setLoading(true);
    setError("");
    try {
      if (importChoice === "demo") {
        const res = await fetch("/api/onboarding/sample-data", { method: "POST" });
        const data = await res.json();
        if (!data.success) {
          setError(data.error || "Could not load sample data.");
          setLoading(false);
          return;
        }
      }
      // Mark onboarding complete
      await fetch("/api/onboarding/complete", { method: "POST" });
      setSetupDone(true);
      setStep("done");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-lg px-6"
      >
        <div className="rounded-2xl border border-border bg-card p-8 shadow-xl">
          {/* Progress bar */}
          {step !== "welcome" && step !== "done" && (
            <div className="mb-6">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                <span>Step {stepIndex} of {STEPS.length - 2}</span>
                <span>{STEP_LABELS[step]}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-indigo-500"
                  initial={{ width: 0 }}
                  animate={{ width: `${((stepIndex) / (STEPS.length - 2)) * 100}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
            </div>
          )}

          <AnimatePresence mode="wait">
            {/* Step: Welcome */}
            {step === "welcome" && (
              <motion.div
                key="welcome"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                <div className="flex flex-col items-center text-center">
                  <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-indigo-500/10 mb-4">
                    <Wallet className="h-10 w-10 text-indigo-500" />
                  </div>
                  <h1 className="text-2xl font-bold tracking-tight">Welcome to PF</h1>
                  <p className="text-sm text-muted-foreground mt-2 max-w-sm">
                    Your personal finance tracker. We&apos;ll help you get set up
                    in just a few steps — it only takes a couple of minutes.
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                    <Shield className="h-5 w-5 text-indigo-500 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">Your data stays private</p>
                      <p className="text-xs text-muted-foreground">
                        Everything is protected with a password only you know
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                    <Database className="h-5 w-5 text-indigo-500 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">Works offline</p>
                      <p className="text-xs text-muted-foreground">
                        No cloud account required — your data lives on your device
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                    <Sparkles className="h-5 w-5 text-indigo-500 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">Smart insights</p>
                      <p className="text-xs text-muted-foreground">
                        See where your money goes with automatic categorization
                      </p>
                    </div>
                  </div>
                </div>

                <button
                  onClick={goNext}
                  className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-medium text-white transition-colors hover:bg-indigo-700 flex items-center justify-center gap-2"
                >
                  Get started
                  <ArrowRight className="h-4 w-4" />
                </button>
              </motion.div>
            )}

            {/* Step: Password */}
            {step === "password" && (
              <motion.div
                key="password"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div className="flex flex-col items-center mb-2">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 mb-3">
                    <Lock className="h-6 w-6 text-indigo-500" />
                  </div>
                  <h2 className="text-lg font-bold">Create your password</h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    This protects all your financial data
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-sm font-medium">Password</label>
                    <button
                      type="button"
                      onClick={() => toggleTip("password")}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <HelpCircle className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <Tooltip
                    text="Pick something memorable but hard to guess. A short phrase like 'purple-mountain-sunrise' works great. You'll need this every time you open PF."
                    visible={!!tipVisible["password"]}
                  />
                  <div className="relative mt-1.5">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      type={showPassphrase ? "text" : "password"}
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="At least 8 characters"
                      className="w-full rounded-lg border border-border bg-background pl-10 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassphrase(!showPassphrase)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                    >
                      {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {passphrase && (
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-muted-foreground">Strength</span>
                        <span>{strength.label}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${strength.color} ${strength.width}`} />
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    Confirm password
                  </label>
                  <input
                    type={showPassphrase ? "text" : "password"}
                    value={confirmPassphrase}
                    onChange={(e) => setConfirmPassphrase(e.target.value)}
                    placeholder="Re-enter your password"
                    className="w-full rounded-lg border border-border bg-background pl-3 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                  {confirmPassphrase && !passwordMatch && (
                    <p className="mt-1 text-xs text-rose-500">Passwords don&apos;t match</p>
                  )}
                </div>

                <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
                  <div className="flex gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      If you forget this password, your data can&apos;t be recovered.
                      There&apos;s no reset option — so write it down somewhere safe.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={goBack}
                    className="flex items-center justify-center gap-1 flex-1 rounded-lg border border-border py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    onClick={goNext}
                    disabled={!passwordMatch}
                    className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step: Storage */}
            {step === "storage" && (
              <motion.div
                key="storage"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div className="flex flex-col items-center mb-2">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 mb-3">
                    <FolderOpen className="h-6 w-6 text-indigo-500" />
                  </div>
                  <h2 className="text-lg font-bold">Where to store your data</h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Choose how you&apos;d like to keep your financial records
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium">Storage mode</label>
                    <button
                      type="button"
                      onClick={() => toggleTip("storage")}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <HelpCircle className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <Tooltip
                    text="'Local only' means your data never leaves this device — it's the most private option. 'Cloud Drive' lets you access your data from multiple devices by syncing through a service you already use."
                    visible={!!tipVisible["storage"]}
                  />
                  <div className="space-y-2 mt-2">
                    <label
                      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        mode === "local" ? "border-indigo-500 bg-indigo-500/5" : "border-border hover:border-muted-foreground"
                      }`}
                    >
                      <input
                        type="radio"
                        name="mode"
                        value="local"
                        checked={mode === "local"}
                        onChange={() => { setMode("local"); setDbPath(""); }}
                        className="mt-1 accent-indigo-600"
                      />
                      <div>
                        <p className="text-sm font-medium">Local only</p>
                        <p className="text-xs text-muted-foreground">
                          Stored on this device. Maximum privacy.
                        </p>
                      </div>
                    </label>
                    <label
                      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        mode === "cloud" ? "border-indigo-500 bg-indigo-500/5" : "border-border hover:border-muted-foreground"
                      }`}
                    >
                      <input
                        type="radio"
                        name="mode"
                        value="cloud"
                        checked={mode === "cloud"}
                        onChange={() => setMode("cloud")}
                        className="mt-1 accent-indigo-600"
                      />
                      <div>
                        <p className="text-sm font-medium">Cloud Drive sync</p>
                        <p className="text-xs text-muted-foreground">
                          Sync via Google Drive, OneDrive, or Dropbox for multi-device access.
                          Your data is still protected by your password.
                        </p>
                      </div>
                    </label>
                  </div>
                </div>

                {mode === "cloud" && (
                  <div>
                    <label className="block text-sm font-medium mb-1.5">
                      Database file location
                    </label>
                    <div className="relative">
                      <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <input
                        type="text"
                        value={dbPath}
                        onChange={(e) => setDbPath(e.target.value)}
                        placeholder="/path/to/Google Drive/pf/pf.db"
                        className="w-full rounded-lg border border-border bg-background pl-10 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Point to a folder synced by your cloud drive provider
                    </p>
                  </div>
                )}

                {hasExistingData && (
                  <div className="rounded-lg bg-indigo-500/10 border border-indigo-500/20 p-3">
                    <p className="text-xs text-indigo-700 dark:text-indigo-400">
                      We found existing data. It will be protected during setup.
                    </p>
                  </div>
                )}

                {error && <p className="text-sm text-rose-500">{error}</p>}

                <div className="flex gap-3">
                  <button
                    onClick={goBack}
                    className="flex items-center justify-center gap-1 flex-1 rounded-lg border border-border py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    onClick={handleSetupEncryption}
                    disabled={(mode === "cloud" && !dbPath) || loading}
                    className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? "Setting up..." : "Protect & continue"}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step: Create Account */}
            {step === "account" && (
              <motion.div
                key="account"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div className="flex flex-col items-center mb-2">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 mb-3">
                    <Wallet className="h-6 w-6 text-indigo-500" />
                  </div>
                  <h2 className="text-lg font-bold">Add your accounts</h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Select the types of accounts you want to track
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium">Quick-add accounts</label>
                    <button
                      type="button"
                      onClick={() => toggleTip("accounts")}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <HelpCircle className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <Tooltip
                    text="Accounts represent where your money lives — like your bank account or credit card. You can add, rename, or remove these later at any time."
                    visible={!!tipVisible["accounts"]}
                  />
                  <div className="space-y-2 mt-2">
                    {ACCOUNT_PRESETS.map((preset, idx) => {
                      const Icon = preset.icon;
                      const selected = selectedAccounts.includes(idx);
                      return (
                        <label
                          key={preset.name}
                          className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                            selected ? "border-indigo-500 bg-indigo-500/5" : "border-border hover:border-muted-foreground"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleAccount(idx)}
                            className="accent-indigo-600"
                          />
                          <Icon className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">{preset.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {preset.type === "A" ? "Asset" : "Liability"} &middot; {preset.group}
                            </p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    Or type a custom account name
                  </label>
                  <input
                    type="text"
                    value={customAccountName}
                    onChange={(e) => setCustomAccountName(e.target.value)}
                    placeholder="e.g. My Savings at XYZ Bank"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                </div>

                {error && <p className="text-sm text-rose-500">{error}</p>}

                <div className="flex gap-3">
                  <button
                    onClick={goBack}
                    className="flex items-center justify-center gap-1 flex-1 rounded-lg border border-border py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    onClick={handleCreateAccounts}
                    disabled={selectedAccounts.length === 0 && !customAccountName.trim()}
                    className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? "Creating..." : "Create accounts"}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step: Import / Demo data */}
            {step === "import" && (
              <motion.div
                key="import"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div className="flex flex-col items-center mb-2">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 mb-3">
                    <Upload className="h-6 w-6 text-indigo-500" />
                  </div>
                  <h2 className="text-lg font-bold">Add some data</h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Try with sample data or import your own files
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium">Choose an option</label>
                    <button
                      type="button"
                      onClick={() => toggleTip("import")}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <HelpCircle className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <Tooltip
                    text="Sample data lets you explore the app with realistic-looking transactions before you add your own. You can clear it any time from Settings."
                    visible={!!tipVisible["import"]}
                  />
                  <div className="space-y-2 mt-2">
                    <label
                      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        importChoice === "demo" ? "border-indigo-500 bg-indigo-500/5" : "border-border hover:border-muted-foreground"
                      }`}
                    >
                      <input
                        type="radio"
                        name="import"
                        value="demo"
                        checked={importChoice === "demo"}
                        onChange={() => setImportChoice("demo")}
                        className="mt-1 accent-indigo-600"
                      />
                      <div>
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                          Load sample data
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Explore the app with demo transactions, budgets, and categories.
                          You can remove this later.
                        </p>
                      </div>
                    </label>
                    <label
                      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        importChoice === "import" ? "border-indigo-500 bg-indigo-500/5" : "border-border hover:border-muted-foreground"
                      }`}
                    >
                      <input
                        type="radio"
                        name="import"
                        value="import"
                        checked={importChoice === "import"}
                        onChange={() => setImportChoice("import")}
                        className="mt-1 accent-indigo-600"
                      />
                      <div>
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          <Upload className="h-3.5 w-3.5 text-indigo-500" />
                          I&apos;ll import my own files
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Skip to the app and import CSV, Excel, PDF, or bank files from the Import page.
                        </p>
                      </div>
                    </label>
                    <label
                      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        importChoice === "skip" ? "border-indigo-500 bg-indigo-500/5" : "border-border hover:border-muted-foreground"
                      }`}
                    >
                      <input
                        type="radio"
                        name="import"
                        value="skip"
                        checked={importChoice === "skip"}
                        onChange={() => setImportChoice("skip")}
                        className="mt-1 accent-indigo-600"
                      />
                      <div>
                        <p className="text-sm font-medium">Start empty</p>
                        <p className="text-xs text-muted-foreground">
                          Jump straight to the dashboard and add data manually later.
                        </p>
                      </div>
                    </label>
                  </div>
                </div>

                {error && <p className="text-sm text-rose-500">{error}</p>}

                <div className="flex gap-3">
                  <button
                    onClick={goBack}
                    className="flex items-center justify-center gap-1 flex-1 rounded-lg border border-border py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    onClick={handleFinish}
                    disabled={loading}
                    className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? "Setting up..." : "Finish setup"}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step: Done */}
            {step === "done" && (
              <motion.div
                key="done"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4 }}
                className="space-y-6"
              >
                <div className="flex flex-col items-center text-center">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 200, delay: 0.2 }}
                    className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/10 mb-4"
                  >
                    <Check className="h-10 w-10 text-emerald-500" />
                  </motion.div>
                  <h2 className="text-2xl font-bold">You&apos;re all set!</h2>
                  <p className="text-sm text-muted-foreground mt-2 max-w-sm">
                    Your data is protected and your accounts are ready.
                    {importChoice === "demo" && " We loaded some sample data so you can explore right away."}
                    {importChoice === "import" && " Head to the Import page to bring in your files."}
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                    <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">Data protection</p>
                      <p className="text-xs text-muted-foreground">AES-256 encryption with your password</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                    <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">Storage</p>
                      <p className="text-xs text-muted-foreground">
                        {mode === "local"
                          ? "Local only — data stays on this device"
                          : `Cloud sync — ${dbPath}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                    <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">Accounts</p>
                      <p className="text-xs text-muted-foreground">
                        {selectedAccounts.length + (customAccountName.trim() ? 1 : 0)} account(s) created
                      </p>
                    </div>
                  </div>
                </div>

                <button
                  onClick={onComplete}
                  className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-medium text-white transition-colors hover:bg-indigo-700 flex items-center justify-center gap-2"
                >
                  Go to dashboard
                  <ArrowRight className="h-4 w-4" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
