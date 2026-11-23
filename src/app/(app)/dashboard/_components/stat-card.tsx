"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/sparkline";
import { AnimatedNumber } from "./animated-number";
import { MonthSwitch } from "./month-switch";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

type StatCardProps = {
  label: string;
  value: number;
  sub: string;
  icon: LucideIcon;
  iconBg: string;
  sparkColor: string;
  sparkData: number[];
  /** Optional "YYYY-MM" labels parallel to sparkData — enables the hover tooltip. */
  sparkLabels?: string[];
  href: string;
  currency?: string;
  /** GH #447: the dashboard's shared last/this month switch, shown under the label. */
  monthSwitch?: { showingCurrent: boolean; onToggle: () => void };
};

export function StatCard({ label, value, sub, icon: Icon, iconBg, sparkColor, sparkData, sparkLabels, href, currency = "USD", monthSwitch }: StatCardProps) {
  const router = useRouter();
  return (
    <motion.div variants={itemVariants}>
      {/* The link is a layer behind the content instead of wrapping the card,
          so the month switch (a button) is not nested inside a link. The text
          lets clicks through to it; the sparkline keeps its hover tooltip and
          opens the same page on click. */}
      <Card className="relative overflow-hidden group cursor-pointer card-hover gradient-border hover:scale-[1.005] transition-transform duration-300 h-full">
        <Link href={href} aria-label={label} className="absolute inset-0 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-ring" />
        <CardContent className="relative pt-4 pb-0 px-5 pointer-events-none">
          {/* Icon + Label top row; the switch drops to its own line when narrow. */}
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 mb-3">
            <div className="flex items-center gap-2.5">
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg shrink-0 transition-transform duration-300 group-hover:scale-110 ${iconBg}`}>
                <Icon className="h-4 w-4" />
              </div>
              <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">{label}</span>
            </div>
            {monthSwitch && (
              <div className="pointer-events-auto">
                <MonthSwitch showingCurrent={monthSwitch.showingCurrent} onToggle={monthSwitch.onToggle} />
              </div>
            )}
          </div>

          {/* Big number */}
          <p className="text-[1.75rem] font-bold tracking-tight hero-number leading-none">
            <AnimatedNumber value={value} currency={currency} />
          </p>

          {/* Subtitle */}
          <p className="text-[11px] text-muted-foreground mt-1 mb-3">{sub}</p>
        </CardContent>

        {/* Full-width sparkline at bottom */}
        {sparkData.length > 1 && (
          <div
            className="relative opacity-50 group-hover:opacity-100 transition-opacity duration-300 -mx-px"
            onClick={() => router.push(href)}
          >
            <Sparkline data={sparkData} color={sparkColor} labels={sparkLabels} currency={currency} />
          </div>
        )}
      </Card>
    </motion.div>
  );
}
