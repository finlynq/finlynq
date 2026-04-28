/**
 * FinlynqLogo — brand mark.
 *
 * A rounded square with an ascending bar-chart path and an accent dot at the peak.
 * Rendered in Finlynq amber (#f5a623) for high-contrast visibility on dark surfaces.
 * Designed to read well from 16px (favicon) up through marketing hero sizes.
 */

export function FinlynqLogo({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Finlynq"
    >
      <rect
        x="1"
        y="1"
        width="20"
        height="20"
        rx="2"
        fill="none"
        stroke="#f5a623"
        strokeWidth="1.5"
      />
      <path
        d="M5 16 L5 9 L10 13 L10 6 L17 11"
        fill="none"
        stroke="#f5a623"
        strokeWidth="1.6"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
      <circle cx="17" cy="11" r="1.6" fill="#f5a623" />
    </svg>
  );
}
