"use client";

interface PageSkeletonProps {
  /** Number of skeleton rows/cards to show */
  rows?: number;
  /** Layout variant */
  variant?: "table" | "cards" | "list";
}

export function PageSkeleton({ rows = 5, variant = "table" }: PageSkeletonProps) {
  if (variant === "cards") {
    return (
      <div className="space-y-5">
        <div className="h-7 w-48 animate-shimmer rounded-lg" />
        <div className="h-4 w-64 animate-shimmer rounded-md" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="h-36 animate-shimmer rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (variant === "list") {
    return (
      <div className="space-y-5">
        <div className="h-7 w-48 animate-shimmer rounded-lg" />
        <div className="h-4 w-64 animate-shimmer rounded-md" />
        <div className="space-y-3 mt-4">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="h-16 animate-shimmer rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  // Default: table variant
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="h-7 w-48 animate-shimmer rounded-lg" />
          <div className="h-4 w-64 animate-shimmer rounded-md mt-2" />
        </div>
        <div className="h-9 w-32 animate-shimmer rounded-lg" />
      </div>
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="h-10 animate-shimmer" />
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-12 animate-shimmer border-t border-border" />
        ))}
      </div>
    </div>
  );
}
