/**
 * FinlynqLogo — brand mark combining Finance ("F" letterform) + Lynq (chain link).
 *
 * Design: A geometric "F" where:
 * - The vertical stem and both crossbars use pill-shaped (fully rounded) strokes,
 *   giving each bar the look of a chain-link bar.
 * - The bottom of the stem terminates in an open ring, the universal chain-link symbol,
 *   explicitly communicating "connection."
 * - Brand gradient: indigo-500 → violet-600 (matches Finlynq's OKLCH palette).
 *
 * Works at any size; uses a stable gradient ID per-instance to avoid SVG id collisions.
 */

let _counter = 0;

export function FinlynqLogo({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  // Stable per-instance ID so multiple logos on the same page don't share gradients.
  // Using a module-level counter is safe in RSC and client components alike.
  const id = `flg-${(_counter++).toString(36)}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Finlynq"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366F1" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>

      {/*
        ── F letterform ──────────────────────────────────────────────
        All three bars are pill-shaped (rx = h/2) so each bar reads as
        a chain-link bar at small sizes.
      */}

      {/* Vertical stem — left edge of the F, runs full height */}
      <rect x="4" y="3" width="6.5" height="20" rx="3.25" fill={`url(#${id})`} />

      {/* Top crossbar — widest bar, anchors the top of the F */}
      <rect x="4" y="3" width="19" height="6.5" rx="3.25" fill={`url(#${id})`} />

      {/* Middle crossbar — narrower, sits at the mid-point of the F */}
      <rect x="4" y="12" width="13" height="5.5" rx="2.75" fill={`url(#${id})`} />

      {/*
        ── Chain link accent ─────────────────────────────────────────
        An open ring at the bottom-right, echoing a chain link.
        Positioned so it's clearly separate from the F body (not crowded),
        yet visually belongs to the composition via shared gradient.
        Size is intentionally smaller so the F letterform remains dominant.
      */}
      <circle
        cx="23.5"
        cy="25.5"
        r="4.5"
        stroke={`url(#${id})`}
        strokeWidth="2.75"
        fill="none"
      />

      {/*
        ── Connector ─────────────────────────────────────────────────
        A short line bridging the stem bottom to the ring, so the two
        elements read as physically connected (chain extends from the F).
      */}
      <line
        x1="10.5"
        y1="25.5"
        x2="19"
        y2="25.5"
        stroke={`url(#${id})`}
        strokeWidth="2.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
