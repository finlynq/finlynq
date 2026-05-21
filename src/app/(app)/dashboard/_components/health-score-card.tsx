"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { motion } from "framer-motion";
import type { HealthData } from "./types";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

function HealthRing({ score, size = 100 }: { score: number; size?: number }) {
  const strokeWidth = 7;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const color = score > 70 ? "#10b981" : score >= 40 ? "#f59e0b" : "#ef4444";

  // Container width/height set via ref-callback (CSP-safe, FINLYNQ-83) so the
  // outer wrapper doesn't carry an HTML `style=` attribute. The inner <svg>
  // takes width/height as attributes, which aren't CSP-gated.
  return (
    <div
      className="relative"
      ref={(el) => {
        if (el) {
          el.style.width = `${size}px`;
          el.style.height = `${size}px`;
        }
      }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted/20"
        />
        {/* `initial` is the framer-motion-owned starting value; `animate`
            drives it to the target. Removing the `style` prop drops the
            initial inline `style=` that framer-motion would otherwise emit
            on the SVG element. (FINLYNQ-83) */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference - progress }}
          transition={{ duration: 1.5, ease: "easeOut" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {/* Score color set via ref-callback (CSP, FINLYNQ-83) */}
        <span
          className="text-2xl font-bold tabular-nums"
          ref={(el) => {
            if (el) el.style.color = color;
          }}
        >
          {score}
        </span>
        <span className="text-[9px] text-muted-foreground font-medium tracking-wide">/ 100</span>
      </div>
    </div>
  );
}

function ScoreBar({ label, score, detail }: { label: string; score: number; detail: string }) {
  const color = score > 70 ? "bg-emerald-500" : score >= 40 ? "bg-amber-500" : "bg-rose-500";

  return (
    <div className="group/bar">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-muted-foreground group-hover/bar:text-foreground transition-colors">
          {label}
        </span>
        <span className="text-[11px] font-semibold tabular-nums">{score}</span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-muted/60 overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${color}`}
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 1, ease: "easeOut", delay: 0.3 }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground/60 mt-0.5 opacity-0 group-hover/bar:opacity-100 transition-opacity">
        {detail}
      </p>
    </div>
  );
}

export function HealthScoreCard() {
  const [health, setHealth] = useState<HealthData | null>(null);

  useEffect(() => {
    fetch("/api/health-score")
      .then((r) => { if (r.ok) return r.json(); })
      .then((d) => { if (d) setHealth(d); });
  }, []);

  return (
    <motion.div variants={itemVariants} className="h-full">
      <Card className="h-full relative overflow-hidden">
        <div className="absolute -top-12 -right-12 w-32 h-32 rounded-full bg-emerald-500/5 blur-2xl pointer-events-none" />
        <CardContent className="relative pt-5 pb-5 h-full">
          <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase mb-4">
            Financial Health
          </p>

          {health ? (
            <div className="flex gap-5 items-start">
              {/* Ring on the left */}
              <div className="shrink-0 flex flex-col items-center">
                <HealthRing score={health.score} size={96} />
                <p
                  className={`mt-1.5 text-xs font-semibold ${
                    health.score > 70
                      ? "text-emerald-500"
                      : health.score >= 40
                        ? "text-amber-500"
                        : "text-rose-500"
                  }`}
                >
                  {health.grade}
                </p>
              </div>

              {/* Progress bars on the right */}
              <div className="flex-1 space-y-2.5 min-w-0">
                {health.components.map((c) => (
                  <ScoreBar key={c.name} label={c.name} score={c.score} detail={c.detail} />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <div className="h-24 w-24 animate-shimmer rounded-full shrink-0" />
              <div className="flex-1 space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-4 animate-shimmer rounded-md" />
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
