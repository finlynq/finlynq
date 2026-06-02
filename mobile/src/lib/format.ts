// Shared formatting helpers used across screens.

/**
 * Currency formatter. Summary tiles use 0 decimals; transaction amounts use 2.
 * Falls back to a plain string if the runtime Intl data lacks the currency
 * (older Hermes builds), so a bad currency code never crashes a render.
 */
export function formatCurrency(
  amount: number,
  currency = "CAD",
  opts?: { decimals?: number }
): string {
  const decimals = opts?.decimals ?? 2;
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    const sign = amount < 0 ? "-" : "";
    return `${sign}${currency} ${Math.abs(amount).toFixed(decimals)}`;
  }
}

/**
 * Decrypted display names can be `null` under a cold DEK (CLAUDE.md invariant).
 * Normalize at the boundary so `.charAt`/`.localeCompare`/render never crash.
 */
export function safeName(name: string | null | undefined, fallback = "—"): string {
  return name && name.trim().length > 0 ? name : fallback;
}

/** First character for an avatar/initial, null-safe. */
export function initial(name: string | null | undefined): string {
  return (name ?? "?").charAt(0).toUpperCase();
}

/**
 * Friendly display name for an account, preferring `alias` over `name` and
 * falling back to `Account #id` when both are null/"" (cold DEK). Mirrors the
 * web `safeAccountName` in src/lib/safe-name.ts.
 */
export function safeAccountName(a: {
  id?: number | string;
  name?: string | null;
  alias?: string | null;
}): string {
  const alias = a.alias?.trim();
  if (alias) return alias;
  const name = a.name?.trim();
  if (name) return name;
  return a.id != null ? `Account #${a.id}` : "Account";
}

/** Short month/day label from an ISO date string (null-safe). */
export function formatShortDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString("en-CA", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}
