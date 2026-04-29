/**
 * Format an account for display in lists, filter dropdowns, and table cells.
 *
 * Accounts whose name is short or purely numeric (e.g. last-4-digits like "609")
 * read as a stray number on their own. When we have an account `type`, prepend
 * it as context: "Credit Card · 609". Alias takes precedence over name when set.
 */
export function formatAccountLabel(a: {
  name: string | null;
  alias?: string | null;
  type?: string | null;
}): string {
  const display = (a.alias && a.alias.trim()) || a.name || "";
  const looksTerse = display.length <= 4 || /^\d+$/.test(display);
  if (looksTerse && a.type) return `${a.type} · ${display}`;
  return display;
}
