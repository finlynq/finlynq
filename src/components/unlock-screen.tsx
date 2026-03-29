"use client";

import { useState } from "react";
import { Lock, Eye, EyeOff, Shield } from "lucide-react";
import { motion } from "framer-motion";

interface UnlockScreenProps {
  onUnlocked: () => void;
}

export function UnlockScreen({ onUnlocked }: UnlockScreenProps) {
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      const data = await res.json();

      if (data.success) {
        onUnlocked();
      } else {
        setError(data.error || "Invalid passphrase");
        setPassphrase("");
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
        className="w-full max-w-md px-6"
      >
        <div className="rounded-2xl border border-border bg-card p-8 shadow-xl">
          <div className="flex flex-col items-center mb-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/10 mb-4">
              <Shield className="h-8 w-8 text-indigo-500" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">PF</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Enter your passphrase to unlock your data
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="passphrase"
                className="block text-sm font-medium mb-1.5"
              >
                Passphrase
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  id="passphrase"
                  type={showPassphrase ? "text" : "password"}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter your passphrase"
                  className="w-full rounded-lg border border-border bg-background pl-10 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  autoFocus
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassphrase(!showPassphrase)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPassphrase ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-sm text-rose-500"
              >
                {error}
              </motion.p>
            )}

            <button
              type="submit"
              disabled={loading || !passphrase}
              className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Unlocking..." : "Unlock"}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Your data is encrypted with AES-256. It never leaves your device.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
