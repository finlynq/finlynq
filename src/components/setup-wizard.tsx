"use client";

import { useState } from "react";
import { Shield, Lock, Eye, EyeOff, FolderOpen, AlertTriangle, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface SetupWizardProps {
  hasExistingData: boolean;
  onComplete: () => void;
}

type Step = "passphrase" | "storage" | "confirm";

function getStrength(passphrase: string): { label: string; color: string; width: string } {
  if (passphrase.length < 8) return { label: "Too short", color: "bg-rose-500", width: "w-1/5" };
  let score = 0;
  if (passphrase.length >= 12) score++;
  if (passphrase.length >= 16) score++;
  if (/[A-Z]/.test(passphrase) && /[a-z]/.test(passphrase)) score++;
  if (/[0-9]/.test(passphrase)) score++;
  if (/[^A-Za-z0-9]/.test(passphrase)) score++;
  if (score <= 1) return { label: "Weak", color: "bg-rose-500", width: "w-2/5" };
  if (score <= 2) return { label: "Fair", color: "bg-amber-500", width: "w-3/5" };
  if (score <= 3) return { label: "Good", color: "bg-emerald-500", width: "w-4/5" };
  return { label: "Strong", color: "bg-emerald-500", width: "w-full" };
}

export function SetupWizard({ hasExistingData, onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>("passphrase");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [dbPath, setDbPath] = useState("");
  const [mode, setMode] = useState<"local" | "cloud">("local");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const strength = getStrength(passphrase);
  const passphraseMatch = passphrase === confirmPassphrase && passphrase.length >= 8;

  async function handleFinish() {
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

      if (data.success) {
        onComplete();
      } else {
        setError(data.error || "Setup failed");
      }
    } catch {
      setError("Failed to connect. Please try again.");
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
          {/* Header */}
          <div className="flex flex-col items-center mb-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10 mb-4">
              <Shield className="h-8 w-8 text-indigo-500" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Welcome to PF</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Set up encryption to protect your financial data
            </p>
          </div>

          {/* Step indicators */}
          <div className="flex items-center justify-center gap-2 mb-8">
            {(["passphrase", "storage", "confirm"] as Step[]).map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={`h-2 w-2 rounded-full transition-colors ${
                    s === step
                      ? "bg-indigo-500"
                      : (["passphrase", "storage", "confirm"].indexOf(step) > i
                          ? "bg-indigo-300"
                          : "bg-border")
                  }`}
                />
              </div>
            ))}
          </div>

          <AnimatePresence mode="wait">
            {/* Step 1: Passphrase */}
            {step === "passphrase" && (
              <motion.div
                key="passphrase"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    Create a passphrase
                  </label>
                  <div className="relative">
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
                    Confirm passphrase
                  </label>
                  <input
                    type={showPassphrase ? "text" : "password"}
                    value={confirmPassphrase}
                    onChange={(e) => setConfirmPassphrase(e.target.value)}
                    placeholder="Re-enter your passphrase"
                    className="w-full rounded-lg border border-border bg-background pl-3 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                  {confirmPassphrase && !passphraseMatch && (
                    <p className="mt-1 text-xs text-rose-500">Passphrases do not match</p>
                  )}
                </div>

                <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
                  <div className="flex gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      If you forget your passphrase, your data cannot be recovered.
                      There is no reset option.
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => setStep("storage")}
                  disabled={!passphraseMatch}
                  className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </motion.div>
            )}

            {/* Step 2: Storage */}
            {step === "storage" && (
              <motion.div
                key="storage"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div>
                  <label className="block text-sm font-medium mb-3">Storage mode</label>
                  <div className="space-y-2">
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
                          Database stored on this device. Maximum privacy.
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
                          Store encrypted DB in Google Drive, OneDrive, or Dropbox for multi-device access.
                        </p>
                      </div>
                    </label>
                  </div>
                </div>

                {mode === "cloud" && (
                  <div>
                    <label className="block text-sm font-medium mb-1.5">
                      Database file path
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
                      Existing data detected. It will be encrypted in place during setup.
                    </p>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={() => setStep("passphrase")}
                    className="flex-1 rounded-lg border border-border py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => setStep("confirm")}
                    disabled={mode === "cloud" && !dbPath}
                    className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </motion.div>
            )}

            {/* Step 3: Confirm */}
            {step === "confirm" && (
              <motion.div
                key="confirm"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div className="space-y-3">
                  <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                    <Check className="h-4 w-4 text-emerald-500" />
                    <div>
                      <p className="text-sm font-medium">Encryption</p>
                      <p className="text-xs text-muted-foreground">AES-256 with your passphrase</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                    <Check className="h-4 w-4 text-emerald-500" />
                    <div>
                      <p className="text-sm font-medium">Storage</p>
                      <p className="text-xs text-muted-foreground">
                        {mode === "local"
                          ? "Local only — data stays on this device"
                          : `Cloud sync — ${dbPath}`}
                      </p>
                    </div>
                  </div>
                  {hasExistingData && (
                    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                      <Check className="h-4 w-4 text-emerald-500" />
                      <div>
                        <p className="text-sm font-medium">Migration</p>
                        <p className="text-xs text-muted-foreground">Existing data will be encrypted</p>
                      </div>
                    </div>
                  )}
                </div>

                {error && (
                  <p className="text-sm text-rose-500">{error}</p>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={() => setStep("storage")}
                    className="flex-1 rounded-lg border border-border py-2.5 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleFinish}
                    disabled={loading}
                    className="flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? "Setting up..." : "Encrypt & Start"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
