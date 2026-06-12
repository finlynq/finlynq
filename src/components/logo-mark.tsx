/**
 * Shared Finlynq brand mark.
 *
 * The amber "chart climbing to a peak" glyph used in the landing nav/footer and
 * the /cloud auth screen. Extracted from landing-client.tsx (FINLYNQ-140) so the
 * auth page and any future surface render the real brand mark instead of a
 * literal "PF" / "FL" placeholder block.
 */
export function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <svg viewBox="0 0 22 22" width="22" height="22">
        <rect x="1" y="1" width="20" height="20" rx="2" fill="none" stroke="#f5a623" strokeWidth="1.5" />
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
    </span>
  );
}
