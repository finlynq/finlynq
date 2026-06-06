/**
 * Heuristic email-body → transaction-candidate parser (Epic B3, 2026-06-05).
 *
 * PURE + dependency-light: no LLM, no network, no DB — financial text never
 * leaves our servers. Recognizes the common shapes of bank/card "you spent $X"
 * alerts, Interac e-transfer notices, and PayPal receipts:
 *
 *   - amount + currency ($ € £ ¥ / CAD USD EUR GBP / C$ US$ …, both orders)
 *   - date            (ISO, "Mon DD, YYYY", "DD Mon YYYY", numeric → normalizeDate)
 *   - payee           (anchors: "at|to|from <X>", "merchant: <X>"; else subject)
 *   - debit/credit    (spent|debited|charged|sent vs deposit|credited|refund)
 *   - last-4          (display only — NEVER part of import_hash)
 *
 * Confidence:
 *   - 'high'  one dominant amount + a real (non-fallback) date + a payee →
 *             eligible for auto-record in the sweep.
 *   - 'low'   ambiguous (multiple amounts, fallback/ambiguous date, no payee) →
 *             never auto-promotes; stays needs_review.
 *   - null    no amount found at all → candidate is null (unparseable).
 *
 * Reuses `parseAmount` (dependency-free) + `normalizeDate` (server-side). The
 * sign convention matches the rest of the app: negative = outflow/spend,
 * positive = inflow/deposit.
 */

import { parseAmount } from "@/lib/parse-amount";
import { normalizeDate } from "@/lib/csv-parser";

export interface ParsedBodyCandidate {
  /** YYYY-MM-DD. */
  date: string;
  /** Signed amount in `currency` — negative = outflow, positive = inflow. */
  amount: number;
  payee: string;
  /** ISO 4217. Defaults to USD when only a bare `$` is present. */
  currency: string;
  note?: string;
  /** Card last-4 if the body mentions one. Display-only; never hashed. */
  last4?: string | null;
}

/**
 * Diagnostic signals the parser computes while deciding confidence. Surfaced
 * (additively) so the Email tab can show the user WHAT was identified and WHY a
 * parse is low-confidence. Existing callers that only read candidate/confidence
 * are unaffected.
 */
export interface ParseBodySignals {
  /** Every amount the parser matched (the same value twice collapses to one). */
  detectedAmounts: { value: number; currency: string }[];
  /** >1 DISTINCT amount value found → the chosen amount is a guess. */
  multipleAmounts: boolean;
  /** The numeric date was ambiguous (MM/DD vs DD/MM, both ≤ 12). */
  dateAmbiguous: boolean;
  /** No date in the body → fell back to the email received date. */
  usedFallbackDate: boolean;
  /** The debit/credit sign came from explicit verbs (vs the outflow default). */
  signExplicit: boolean;
  /** Card last-4 mentioned in the body (display-only; never hashed). */
  last4: string | null;
}

export interface ParseEmailBodyResult {
  candidate: ParsedBodyCandidate | null;
  confidence: "high" | "low" | null;
  /** Optional — present on any return that reached amount collection. */
  signals?: ParseBodySignals;
}

export interface ParseEmailBodyInput {
  text?: string | null;
  html?: string | null;
  subject?: string | null;
  /** Email received date (YYYY-MM-DD) — used as the date fallback when the
   *  body carries no parseable date. Using the fallback downgrades to 'low'. */
  receivedDate?: string | null;
}

// ─── Currency tokens ─────────────────────────────────────────────────────────
// Dollar-family symbols + ISO codes we recognize. Order matters: multi-char
// prefixes (C$, US$) must come before bare `$` in the alternation.
const SYMBOL_TO_ISO: Array<[string, string]> = [
  ["C$", "CAD"],
  ["CA$", "CAD"],
  ["US$", "USD"],
  ["A$", "AUD"],
  ["AU$", "AUD"],
  ["NZ$", "NZD"],
  ["HK$", "HKD"],
  ["S$", "SGD"],
  ["MX$", "MXN"],
  ["$", "USD"], // bare $ → app default USD
  ["£", "GBP"],
  ["€", "EUR"],
  ["¥", "JPY"],
  ["₹", "INR"],
];
const ISO_CODES = [
  "USD", "CAD", "EUR", "GBP", "JPY", "AUD", "NZD", "CHF", "CNY", "HKD",
  "SGD", "MXN", "INR", "SEK", "NOK", "DKK", "ZAR", "BRL",
];

// Alternation of symbols (escaped) for the "symbol-before-amount" pattern.
const SYMBOL_ALT = SYMBOL_TO_ISO.map(([s]) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|");
const ISO_ALT = ISO_CODES.join("|");

// Number with optional thousands separators + optional decimals.
const NUM = "\\d{1,3}(?:[,\\s]\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?";

// "$42.17", "C$ 1,234.56", "€5,00"
const SYMBOL_BEFORE = new RegExp(`(${SYMBOL_ALT})\\s?(${NUM})`, "g");
// "42.17 USD", "1,234.56 CAD"
const CODE_AFTER = new RegExp(`\\b(${NUM})\\s?(${ISO_ALT})\\b`, "gi");

interface AmountHit {
  value: number;
  currency: string;
}

function symbolToIso(sym: string): string {
  const hit = SYMBOL_TO_ISO.find(([s]) => s === sym);
  return hit ? hit[1] : "USD";
}

function collectAmounts(haystack: string): AmountHit[] {
  const hits: AmountHit[] = [];
  let m: RegExpExecArray | null;

  SYMBOL_BEFORE.lastIndex = 0;
  while ((m = SYMBOL_BEFORE.exec(haystack)) !== null) {
    const value = parseAmount(m[2]);
    if (!Number.isNaN(value)) {
      hits.push({ value, currency: symbolToIso(m[1]) });
    }
  }

  CODE_AFTER.lastIndex = 0;
  while ((m = CODE_AFTER.exec(haystack)) !== null) {
    const value = parseAmount(m[1]);
    if (!Number.isNaN(value)) {
      hits.push({ value, currency: m[2].toUpperCase() });
    }
  }

  return hits;
}

// ─── Date extraction ─────────────────────────────────────────────────────────
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

interface DateHit {
  iso: string;
  /** True when the numeric form was ambiguous (MM/DD vs DD/MM auto-detected). */
  ambiguous: boolean;
}

function extractDate(haystack: string): DateHit | null {
  // 1) ISO YYYY-MM-DD
  const iso = haystack.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    const norm = normalizeDate(iso[1]);
    if (norm) return { iso: norm, ambiguous: false };
  }

  // 2) "Jun 5, 2026" / "June 5, 2026" / "5 Jun 2026"
  const monthName =
    haystack.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/) ||
    haystack.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (monthName) {
    // Figure out which capture is the month name vs the day.
    const a = monthName[1];
    const b = monthName[2];
    const year = monthName[3];
    const aIsMonth = /[A-Za-z]/.test(a);
    const monStr = (aIsMonth ? a : b).slice(0, 3).toLowerCase();
    const dayStr = aIsMonth ? b : a;
    const mm = MONTHS[monStr];
    if (mm) {
      const dd = String(parseInt(dayStr, 10)).padStart(2, "0");
      const norm = normalizeDate(`${year}-${mm}-${dd}`);
      if (norm) return { iso: norm, ambiguous: false };
    }
  }

  // 3) Numeric MM/DD/YYYY or DD/MM/YYYY → normalizeDate auto-detects.
  const numeric = haystack.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
  if (numeric) {
    const norm = normalizeDate(numeric[1]);
    if (norm) {
      const [a, b] = numeric[1].split("/").map((n) => parseInt(n, 10));
      // Ambiguous when both halves are ≤ 12 (could be either order).
      const ambiguous = a <= 12 && b <= 12;
      return { iso: norm, ambiguous };
    }
  }

  return null;
}

// ─── Sign (debit vs credit) ──────────────────────────────────────────────────
const OUTFLOW_RE =
  /\b(spent|debit(?:ed)?|withdraw(?:n|al)?|charg(?:ed|e)|sent|purchase[d]?|paid|payment to|deduct(?:ed)?)\b/i;
const INFLOW_RE =
  /\b(deposit(?:ed)?|credit(?:ed)?|receiv(?:ed|e)|refund(?:ed)?|payment from|added|incoming)\b/i;

function detectSign(haystack: string): { sign: -1 | 1; explicit: boolean } {
  const out = OUTFLOW_RE.test(haystack);
  const inn = INFLOW_RE.test(haystack);
  if (out && !inn) return { sign: -1, explicit: true };
  if (inn && !out) return { sign: 1, explicit: true };
  // Unknown or conflicting — default to outflow (the dominant alert shape).
  return { sign: -1, explicit: false };
}

// ─── Payee extraction ────────────────────────────────────────────────────────
function extractPayee(text: string, subject: string | null): string | null {
  // "merchant: STARBUCKS"
  const labelled = text.match(/\bmerchant\s*[:\-]\s*([^\n.,;]{2,60})/i);
  if (labelled) return cleanPayee(labelled[1]);

  // "at STARBUCKS on", "to John Doe for", "from PayPal."  — stop at a
  // connective word or sentence punctuation.
  const anchored = text.match(
    /\b(?:at|to|from)\s+([A-Z0-9][^\n]*?)(?=\s+(?:on|for|with|using|ending|via|—|-)\b|[.,;!?\n]|$)/,
  );
  if (anchored) {
    const cleaned = cleanPayee(anchored[1]);
    if (cleaned && cleaned.length >= 2) return cleaned;
  }

  // Fall back to the subject line (minus common noise).
  if (subject) {
    const s = cleanPayee(
      subject.replace(/\b(re|fwd?):/gi, "").replace(/\b(alert|notification|receipt|transaction)\b/gi, ""),
    );
    if (s && s.length >= 2) return s;
  }

  return null;
}

function cleanPayee(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[*]+/g, "")
    .trim()
    .slice(0, 80);
}

function extractLast4(haystack: string): string | null {
  const m = haystack.match(/\bending\s+(?:in\s+)?\*?\*?(\d{4})\b/i) ||
    haystack.match(/\bcard\s+(?:ending\s+)?(?:in\s+)?\*+(\d{4})\b/i) ||
    haystack.match(/\b\*{2,}\s*(\d{4})\b/);
  return m ? m[1] : null;
}

/** Strip HTML tags → text. Lightweight (no dep) — collapses tags + entities.
 *  Exported so the rule-match sweep can search the body of HTML-only emails. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse an email body into a single transaction candidate. Pure: same input
 * → same output (no clock/network). The caller passes `receivedDate` for the
 * date fallback.
 */
export function parseEmailBody(input: ParseEmailBodyInput): ParseEmailBodyResult {
  const subject = input.subject ?? null;
  const bodyText =
    (input.text && input.text.trim())
      ? input.text
      : input.html
        ? htmlToText(input.html)
        : "";
  // Search space = subject + body (subject often carries the merchant + amount).
  const haystack = `${subject ?? ""}\n${bodyText}`.trim();

  if (!haystack) return { candidate: null, confidence: null };

  const amounts = collectAmounts(haystack);
  const last4 = extractLast4(haystack);
  if (amounts.length === 0) {
    return {
      candidate: null,
      confidence: null,
      signals: {
        detectedAmounts: [],
        multipleAmounts: false,
        dateAmbiguous: false,
        usedFallbackDate: false,
        signExplicit: false,
        last4,
      },
    };
  }

  // Distinct amount VALUES (the same $42.17 mentioned twice is one amount).
  const distinctValues = new Set(amounts.map((a) => a.value.toFixed(2)));
  const multipleAmounts = distinctValues.size > 1;
  // Pick the first matched amount as the transaction amount.
  const chosen = amounts[0];

  const dateHit = extractDate(haystack);
  const usedFallbackDate = !dateHit;
  const dateAmbiguous = dateHit?.ambiguous ?? false;
  const date = dateHit?.iso ?? input.receivedDate ?? null;

  const { sign, explicit } = detectSign(haystack);

  const signals: ParseBodySignals = {
    detectedAmounts: amounts.map((a) => ({ value: a.value, currency: a.currency })),
    multipleAmounts,
    dateAmbiguous,
    usedFallbackDate,
    signExplicit: explicit,
    last4,
  };

  if (!date) {
    // No date in the body and no received-date fallback — can't build a hash.
    return { candidate: null, confidence: null, signals };
  }

  const payee = extractPayee(bodyText, subject);

  const candidate: ParsedBodyCandidate = {
    date,
    amount: sign * Math.abs(chosen.value),
    payee: payee ?? "Unknown",
    currency: chosen.currency,
    note: subject ?? undefined,
    last4,
  };

  // Confidence: high only when unambiguous on every axis.
  const ambiguous = multipleAmounts || usedFallbackDate || dateAmbiguous || payee == null;
  const confidence: "high" | "low" = ambiguous ? "low" : "high";

  return { candidate, confidence, signals };
}
