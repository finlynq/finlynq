"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, Bell, CheckCircle2, X, ChevronRight, Shield } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { motion, AnimatePresence } from "framer-motion";
import type { SpotlightItem } from "./types";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

const SEVERITY_ICON = {
  critical: { icon: AlertTriangle, color: "text-rose-500", dot: "bg-rose-500" },
  warning: { icon: AlertTriangle, color: "text-amber-500", dot: "bg-amber-500" },
  info: { icon: Bell, color: "text-blue-500", dot: "bg-blue-500" },
};

const MAX_VISIBLE = 3;

export function ActionCenter() {
  const [items, setItems] = useState<SpotlightItem[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = localStorage.getItem("pf-spotlight-dismissed");
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    fetch("/api/spotlight").then((r) => r.json()).then((d) => setItems(d.items));
  }, []);

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    try {
      localStorage.setItem("pf-spotlight-dismissed", JSON.stringify([...next]));
    } catch { /* ignore */ }
  };

  if (!items) return null;

  const visible = items.filter((i) => !dismissed.has(i.id));
  const displayItems = showAll ? visible : visible.slice(0, MAX_VISIBLE);
  const hasMore = visible.length > MAX_VISIBLE;

  return (
    <motion.div variants={itemVariants}>
      <Card className="card-hover">
        <CardHeader className="pb-2 px-5 pt-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400">
              <Shield className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-sm font-semibold">Action Center</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                {visible.length === 0 ? "All clear" : `${visible.length} item${visible.length !== 1 ? "s" : ""} need attention`}
              </p>
            </div>
          </div>
        </CardHeader>

        <CardContent className="px-5 pb-4">
          {visible.length === 0 ? (
            <div className="flex items-center gap-3 py-3 px-3 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/30">
              <CheckCircle2 className="h-4.5 w-4.5 text-emerald-500 shrink-0" />
              <div>
                <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">All good!</p>
                <p className="text-[11px] text-muted-foreground">No items need your attention right now.</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              <AnimatePresence mode="popLayout">
                {displayItems.map((item, i) => {
                  const config = SEVERITY_ICON[item.severity];
                  const Icon = config.icon;
                  return (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -80 }}
                      transition={{ duration: 0.25, delay: i * 0.04 }}
                      className="group flex items-center gap-3 py-3 first:pt-1"
                    >
                      {/* Severity dot */}
                      <div className={`h-2 w-2 rounded-full shrink-0 ${config.dot}`} />

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-[13px] font-medium truncate">{item.title}</p>
                          {item.amount !== undefined && (
                            <span className="text-[11px] font-mono font-semibold text-muted-foreground tabular-nums">
                              {formatCurrency(item.amount, "CAD")}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">{item.description}</p>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 shrink-0">
                        <Link
                          href={item.actionUrl}
                          className="text-[11px] font-medium text-primary hover:text-primary/80 transition-colors px-2 py-1 rounded-md hover:bg-primary/5"
                        >
                          View
                        </Link>
                        <button
                          onClick={() => dismiss(item.id)}
                          className="p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-muted/80 transition-all"
                          title="Dismiss"
                        >
                          <X className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}

          {/* View All button */}
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-2 w-full flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium text-primary hover:text-primary/80 hover:bg-primary/5 rounded-lg transition-colors"
            >
              View all {visible.length} alerts
              <ChevronRight className="h-3 w-3" />
            </button>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
