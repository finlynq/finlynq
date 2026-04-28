"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/sparkline";
import { AnimatedNumber } from "./animated-number";
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
  href: string;
  currency?: string;
};

export function StatCard({ label, value, sub, icon: Icon, iconBg, sparkColor, sparkData, href, currency = "CAD" }: StatCardProps) {
  return (
    <motion.div variants={itemVariants}>
      <Link href={href}>
        <Card className="relative overflow-hidden group cursor-pointer card-hover gradient-border hover:scale-[1.005] transition-transform duration-300 h-full">
          <CardContent className="pt-4 pb-0 px-5">
            {/* Icon + Label top row */}
            <div className="flex items-center gap-2.5 mb-3">
              <div className={`flex h-8 w-8 items-center justify-center rounded-lg shrink-0 transition-transform duration-300 group-hover:scale-110 ${iconBg}`}>
                <Icon className="h-4 w-4" />
              </div>
              <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">{label}</span>
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
            <div className="opacity-50 group-hover:opacity-100 transition-opacity duration-300 -mx-px">
              <Sparkline data={sparkData} color={sparkColor} />
            </div>
          )}
        </Card>
      </Link>
    </motion.div>
  );
}
