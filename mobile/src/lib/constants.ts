// Option constants for the mobile create flows. Mobile can't import the web
// `src/lib`, so these small enum lists mirror the web sources directly:
//   - ACCOUNT_TYPES / ACCOUNT_GROUPS — accounts page (src/app/(app)/accounts/page.tsx)
//   - CATEGORY_TYPES — category type label set (settings/categorization page)
//   - GOAL_TYPES / GOAL_PRIORITIES — goals page (src/app/(app)/goals/page.tsx)
// Keep these in sync if the web lists change.

export const ACCOUNT_TYPES: { value: "A" | "L"; label: string }[] = [
  { value: "A", label: "Asset" },
  { value: "L", label: "Liability" },
];

// Per-type account group options (dynamic: the picker swaps lists on type flip).
export const ACCOUNT_GROUPS: Record<"A" | "L", string[]> = {
  A: ["Cash", "Checking", "Savings", "Investment", "Property", "Other"],
  L: ["Credit Card", "Loan", "Mortgage", "Other"],
};

// Category type labels mirror the web (settings/categorization page): R is
// "Reconciliation", not "Transfer".
export const CATEGORY_TYPES: { value: "E" | "I" | "R"; label: string }[] = [
  { value: "E", label: "Expense" },
  { value: "I", label: "Income" },
  { value: "R", label: "Reconciliation" },
];

export const GOAL_TYPES: { value: string; label: string }[] = [
  { value: "savings", label: "Savings" },
  { value: "debt_payoff", label: "Debt Payoff" },
  { value: "investment", label: "Investment" },
  { value: "emergency_fund", label: "Emergency Fund" },
];

export const GOAL_PRIORITIES: { value: number; label: string }[] = [
  { value: 1, label: "High" },
  { value: 2, label: "Medium" },
  { value: 3, label: "Low" },
];

// Small currency picker list. Display-currency-aware defaulting is a follow-up;
// the pickers default to CAD for now.
export const COMMON_CURRENCIES = ["CAD", "USD", "EUR", "GBP"] as const;

export const DEFAULT_CURRENCY = "CAD";

// Display-currency picker (Settings → GENERAL). Mirrors the web
// SUPPORTED_FIAT_CURRENCIES list + CURRENCY_LABELS (src/lib/fx/
// supported-currencies.ts). Display currency is a 3-letter ISO code — the
// PUT /api/settings/display-currency route enforces `^[A-Z]{3}$` + the
// supported set, so we offer the fiat list only (no 4-letter crypto codes).
export const DISPLAY_CURRENCIES: { code: string; label: string }[] = [
  { code: "USD", label: "US Dollar" },
  { code: "CAD", label: "Canadian Dollar" },
  { code: "EUR", label: "Euro" },
  { code: "GBP", label: "British Pound" },
  { code: "JPY", label: "Japanese Yen" },
  { code: "AUD", label: "Australian Dollar" },
  { code: "CHF", label: "Swiss Franc" },
  { code: "NZD", label: "New Zealand Dollar" },
  { code: "CNY", label: "Chinese Yuan" },
  { code: "HKD", label: "Hong Kong Dollar" },
  { code: "SGD", label: "Singapore Dollar" },
  { code: "SEK", label: "Swedish Krona" },
  { code: "NOK", label: "Norwegian Krone" },
  { code: "DKK", label: "Danish Krone" },
  { code: "PLN", label: "Polish Złoty" },
  { code: "CZK", label: "Czech Koruna" },
  { code: "HUF", label: "Hungarian Forint" },
  { code: "RON", label: "Romanian Leu" },
  { code: "TRY", label: "Turkish Lira" },
  { code: "ILS", label: "Israeli Shekel" },
  { code: "ZAR", label: "South African Rand" },
  { code: "INR", label: "Indian Rupee" },
  { code: "KRW", label: "South Korean Won" },
  { code: "THB", label: "Thai Baht" },
  { code: "IDR", label: "Indonesian Rupiah" },
  { code: "MYR", label: "Malaysian Ringgit" },
  { code: "PHP", label: "Philippine Peso" },
  { code: "MXN", label: "Mexican Peso" },
  { code: "BRL", label: "Brazilian Real" },
  { code: "ARS", label: "Argentine Peso" },
  { code: "COP", label: "Colombian Peso" },
  { code: "CLP", label: "Chilean Peso" },
];
