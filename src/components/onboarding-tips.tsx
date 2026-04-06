"use client";

import { useState, useEffect } from "react";
import { X, Lightbulb, ArrowRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";

interface OnboardingTip {
  id: string;
  title: string;
  description: string;
  action?: { label: string; href: string };
}

const STORAGE_KEY = "pf-dismissed-tips";

function getDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function setDismissed(ids: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
}

interface OnboardingTipsProps {
  page: "dashboard" | "transactions" | "budgets" | "accounts" | "import";
}

const TIPS_BY_PAGE: Record<string, OnboardingTip[]> = {
  dashboard: [
    {
      id: "dash-overview",
      title: "This is your financial overview",
      description:
        "Your dashboard shows your net worth, income vs. spending, and alerts at a glance. Cards link to detailed pages.",
      action: { label: "View accounts", href: "/accounts" },
    },
    {
      id: "dash-import",
      title: "Import your bank statements",
      description:
        "Bring in CSV or OFX/QFX files from your bank to see real data here. The more data you add, the better your insights.",
      action: { label: "Import files", href: "/import" },
    },
  ],
  transactions: [
    {
      id: "txn-search",
      title: "Find any transaction",
      description:
        "Use the search bar to filter by payee, note, or tag. You can also filter by date range, account, or category.",
    },
    {
      id: "txn-categorize",
      title: "Categorize for better insights",
      description:
        "Assigning categories to transactions powers your budget tracking and spending breakdown charts.",
    },
  ],
  budgets: [
    {
      id: "budget-start",
      title: "Set monthly spending limits",
      description:
        "Create budgets per category to track your spending. You'll see progress bars showing how much you've used each month.",
    },
  ],
  accounts: [
    {
      id: "acct-types",
      title: "Track all your money in one place",
      description:
        "Add bank accounts, credit cards, investments, and loans. Your net worth is calculated from the total of all accounts.",
    },
  ],
  import: [
    {
      id: "import-formats",
      title: "Multiple formats supported",
      description:
        "Upload CSV or OFX/QFX files from your bank. We'll detect duplicates automatically so nothing gets counted twice.",
    },
  ],
};

export function OnboardingTips({ page }: OnboardingTipsProps) {
  const [dismissed, setDismissedState] = useState<Set<string>>(new Set());
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setDismissedState(getDismissed());
    setMounted(true);
  }, []);

  const tips = (TIPS_BY_PAGE[page] ?? []).filter((t) => !dismissed.has(t.id));

  function dismiss(id: string) {
    const next = new Set(dismissed);
    next.add(id);
    setDismissedState(next);
    setDismissed(next);
  }

  function dismissAll() {
    const next = new Set(dismissed);
    tips.forEach((t) => next.add(t.id));
    setDismissedState(next);
    setDismissed(next);
  }

  if (!mounted || tips.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20 p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-indigo-500" />
          <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">
            Tips for getting started
          </span>
        </div>
        <button
          onClick={dismissAll}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Dismiss all
        </button>
      </div>

      <AnimatePresence>
        {tips.map((tip) => (
          <motion.div
            key={tip.id}
            layout
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            className="flex items-start gap-3 rounded-lg bg-white dark:bg-card border border-border p-3"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{tip.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{tip.description}</p>
              {tip.action && (
                <Link
                  href={tip.action.href}
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline mt-1.5"
                >
                  {tip.action.label}
                  <ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </div>
            <button
              onClick={() => dismiss(tip.id)}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}
