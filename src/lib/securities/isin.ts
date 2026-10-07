/**
 * ISIN recognition (ISO 6166), pure + client-safe. GH #365: brokers such as
 * Zerodha export holdings by ISIN, and Indian mutual funds have no exchange
 * ticker at all, so a user often only HAS the ISIN. `isin-resolve.ts` turns a
 * valid one into the Yahoo symbol we price with.
 *
 * Shape: 2-letter country code, 9 alphanumerics, 1 check digit — 12 chars.
 * The check digit is validated (letters → 10..35, then Luhn over the digit
 * string), so an ordinary 12-character ticker never mis-detects as an ISIN.
 */

const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Upper-cased, trimmed candidate. */
export function normalizeIsin(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isIsin(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = normalizeIsin(raw);
  if (!ISIN_SHAPE.test(s)) return false;

  // Expand letters to their two-digit values (A=10 … Z=35), keep digits.
  let digits = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    digits += code >= 65 ? String(code - 55) : ch;
  }
  // Luhn: double every second digit from the right, starting with the one
  // left of the check digit.
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
