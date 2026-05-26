/**
 * Friendly-fallback display names for entities whose decrypted name may be
 * null at render time. Stream D Phase 4 encrypts display names on 6 tables
 * (accounts, categories, portfolio_holdings, goals, loans, subscriptions);
 * reads return `null` when the DEK is unavailable (cold cache after a
 * service restart, or auth-tag mismatch). Callers that feed these strings
 * straight into Combobox labels + sort comparators crashed on
 * `null.localeCompare(...)` — see HANDOVER_NEXT_COMBOBOX_HARDENING.md.
 *
 * Use `safeName(...)` at the boundary where a `{ id, name }` row becomes a
 * UI label, so every downstream sort/render sees a non-null string. Use
 * `safeAccountName(...)` for accounts, which prefer `alias` over `name`.
 */

export function safeName(
  name: string | null | undefined,
  kind: string,
  id: number,
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return `${kind} #${id}`;
}

export function safeAccountName(a: {
  id: number;
  name: string | null | undefined;
  alias?: string | null | undefined;
}): string {
  const alias = a.alias?.trim();
  if (alias) return alias;
  const name = a.name?.trim();
  if (name) return name;
  return `Account #${a.id}`;
}
