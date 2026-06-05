/**
 * `parseAmount` — pure, dependency-free amount-string parser.
 *
 * Split out of `csv-parser.ts` (2026-06-04) so client components (e.g. the
 * import column-mapping dialog's live sample preview) can reuse it WITHOUT
 * dragging `csv-parser.ts`'s server-only `@/db` import — and therefore the
 * `pg` Postgres driver (`dns`/`fs`) — into the browser bundle. `csv-parser.ts`
 * re-exports this so existing server-side callers keep importing it from there.
 *
 * This module MUST stay free of any server-only / Node-built-in imports.
 */

/**
 * Parse a raw amount string, handling:
 * - Currency symbols ($, €, £, ¥)
 * - Thousands separators (commas and spaces)
 * - Parenthesized negatives: (1,234.56) → -1234.56
 * - Unicode minus (−)
 * - European format: 1.234,56 → 1234.56
 */
export function parseAmount(raw: string): number {
  if (!raw || !raw.trim()) return NaN;

  let s = raw.trim();

  // Remove currency symbols
  s = s.replace(/[$€£¥₹]/g, "");

  // Unicode minus → regular minus
  s = s.replace(/−/g, "-");

  // Parenthesized negatives
  if (s.startsWith("(") && s.endsWith(")")) {
    s = "-" + s.slice(1, -1);
  }

  s = s.trim();

  // Detect European format: if there's exactly one comma and it has 2 digits after it
  // AND either no dots or dots used as thousands separators
  const europeanMatch = s.match(/^-?\d{1,3}(\.\d{3})*,\d{1,2}$/);
  if (europeanMatch) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Standard format: remove commas and spaces used as thousands separators
    s = s.replace(/[,\s]/g, "");
  }

  const result = parseFloat(s);
  return isNaN(result) ? NaN : result;
}
