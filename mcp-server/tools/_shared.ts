/**
 * Shared context + helpers for the per-group MCP HTTP tool modules
 * (FINLYNQ-109). `registerPgTools` (register-tools-pg.ts) builds one
 * `PgToolContext` and hands it to each group's `registerXTools(server, ctx)`.
 *
 * Everything here was lifted verbatim out of register-tools-pg.ts so the
 * handler bodies (moved into the group modules) keep compiling unchanged.
 * The one intentional consolidation is `resolveStrict` — the single generic
 * that replaced the three near-identical `resolve{Account,Category,
 * PortfolioHolding}Strict` copies (behaviour-preserving; the named wrappers
 * below re-key its `row` field so every callsite is byte-identical).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { normalizeDbRows } from "../../src/lib/db-utils";
import { decryptField } from "../../src/lib/crypto/envelope";
import { encryptName, nameLookup } from "../../src/lib/crypto/encrypted-columns";
import { SUPPORTED_CURRENCIES } from "../../src/lib/fx/supported-currencies";
import { resolveOrCreateInvestmentIncomeCategory } from "../../src/lib/investment-income-category";
import {
  pickInvestmentCategoryByPayee,
  fallbackInvestmentCategory,
  type InvestmentCategoryHint,
} from "../../src/lib/auto-categorize";

// ─── types ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbLike = { execute: (q: ReturnType<typeof sql>) => Promise<any> };

/**
 * The shared closure state every group module needs. Built once in
 * `registerPgTools` and destructured at the top of each `registerXTools`.
 */
export interface PgToolContext {
  db: DbLike;
  userId: string;
  dek: Buffer | null;
  /** Phase 2 (2026-06-01) note-column encrypt/decrypt helpers (DEK-bound). */
  encNote: (v: string | null | undefined) => string;
  decNote: (v: string | null | undefined) => string | null;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

export async function q(db: DbLike, query: ReturnType<typeof sql>): Promise<Row[]> {
  return normalizeDbRows<Row>(await db.execute(query));
}
const IDEMPOTENCY_MUTEX_KEY = "__pf_mcp_idempotency_mutex__";
type GlobalWithMutex = typeof globalThis & {
  [IDEMPOTENCY_MUTEX_KEY]?: Map<string, Promise<unknown>>;
};
function getIdempotencyMutex(): Map<string, Promise<unknown>> {
  const g = globalThis as GlobalWithMutex;
  if (!g[IDEMPOTENCY_MUTEX_KEY]) g[IDEMPOTENCY_MUTEX_KEY] = new Map();
  return g[IDEMPOTENCY_MUTEX_KEY]!;
}
export async function withIdempotencyMutex<T>(
  userId: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const map = getIdempotencyMutex();
  const lockKey = `${userId}::${key}`;
  // Wait for any in-flight call with the same key.
  const prev = map.get(lockKey);
  if (prev) {
    try {
      await prev;
    } catch {
      // Predecessor failure must not block this attempt.
    }
  }
  const run = (async () => fn())();
  // Hold the slot until run settles, then clean up so the map doesn't grow.
  map.set(lockKey, run);
  try {
    return await run;
  } finally {
    if (map.get(lockKey) === run) map.delete(lockKey);
  }
}
export function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Issue #237 — unified envelope helper for read tools that previously
 * returned raw arrays/objects via `text(rawValue)`. Wraps the value in the
 * canonical `{ success: true, data: <T> }` envelope so every MCP read tool
 * returns the same outer shape. Same wire encoding as `text()` — only the
 * shape of the JSON inside differs.
 *
 * Use this for new read-tool surfaces and when normalizing legacy callsites.
 * Existing `text({ success: true, data: ... })` writes don't need to change.
 */
export function dataResponse(data: unknown) {
  return text({ success: true, data });
}

export function err(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

/**
 * Build a top-N "did you mean ..." list for error messages without dumping
 * the user's whole inventory into LLM logs / Sentry / browser network panel.
 *
 * Issue #211 (Bug e): the previous `Available: <full list>` formatter
 * leaked every account/category name (including liability labels) into
 * any error path. Now we surface at most `maxCount` near-matches ranked by
 * a cheap edit-distance signal:
 *   1) startsWith(query)
 *   2) substring of query
 *   3) shortest edit distance
 *
 * Names only — no `(id=N)` suffix unless `includeIds: true` is passed
 * (the few callsites that genuinely need the id, e.g. `update_holding`,
 * opt in explicitly so the default is privacy-safe).
 */
export function suggestionList(
  query: string,
  options: Row[],
  opts?: { maxCount?: number; includeIds?: boolean; field?: "name" | "symbol" }
): string {
  const maxCount = opts?.maxCount ?? 5;
  const includeIds = opts?.includeIds ?? false;
  const field = opts?.field ?? "name";
  if (!options.length) return "(no candidates)";
  const lo = (query ?? "").toLowerCase().trim();
  const editDistance = (a: string, b: string): number => {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = a.length, n = b.length;
    let prev = new Array<number>(n + 1).fill(0);
    let cur = new Array<number>(n + 1).fill(0);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  };
  const scored = options
    .map(o => {
      const name = String(o[field] ?? "").trim();
      if (!name) return null;
      const lname = name.toLowerCase();
      let bucket = 3;
      if (lo && lname.startsWith(lo)) bucket = 0;
      else if (lo && lname.includes(lo)) bucket = 1;
      else if (lo && lo.includes(lname)) bucket = 2;
      const dist = lo ? editDistance(lname, lo) : 0;
      return { o, name, bucket, dist };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => (a.bucket - b.bucket) || (a.dist - b.dist) || a.name.localeCompare(b.name))
    .slice(0, maxCount);
  if (!scored.length) return "(no candidates)";
  return scored
    .map(s => includeIds ? `"${s.name}" (id=${Number(s.o.id)})` : `"${s.name}"`)
    .join(", ");
}

// Issue #206 — currency enum widened to the full SUPPORTED_CURRENCIES list
// (32 fiats + 4 cryptos + 4 metals). Zod requires the literal-tuple cast.
export const supportedCurrencyEnum = z.enum(
  SUPPORTED_CURRENCIES as unknown as [string, ...string[]]
);

/**
 * Fuzzy match against a row list: exact-name → exact-alias → startsWith-name →
 * contains-name → reverse-contains-name.
 *
 * Alias match is exact-only (case-insensitive, trimmed). Aliases are meant to
 * be precise shorthands like "1234" or "Visa4242"; loose matching on a short
 * alias would false-match too often. Only rows carrying an `alias` column
 * (accounts) exercise the alias branch — for other row shapes it's a no-op.
 */
export function fuzzyFind(input: string, options: Row[]): Row | null {
  if (!input || !options.length) return null;
  const lo = input.toLowerCase().trim();
  return (
    options.find(o => String(o.name  ?? "").toLowerCase() === lo) ??
    options.find(o => String(o.alias ?? "").toLowerCase() === lo) ??
    options.find(o => String(o.name  ?? "").toLowerCase().startsWith(lo)) ??
    options.find(o => String(o.name  ?? "").toLowerCase().includes(lo)) ??
    options.find(o => lo.includes(String(o.name ?? "").toLowerCase())) ??
    null
  );
}

// ─── generic strict resolver (FINLYNQ-109 collapse) ─────────────────────────────
//
// Single source of truth for the three former near-identical strict resolvers
// (`resolveAccountStrict`, `resolveCategoryStrict`,
// `resolvePortfolioHoldingStrict`). Same waterfall as `fuzzyFind`, but:
//   1. exact tiers first (name, then any additional exact fields e.g. alias/symbol);
//   2. startsWith tier(s);
//   3. a token-overlap-gated substring tier on `substringField` (length-≥3
//      whitespace tokens) so a sloppy short input never silently routes a
//      write to a vaguely-similar row;
//   4. a `low_confidence` fallback surfacing what `fuzzyFind` WOULD have
//      matched, so the caller can format "did you mean …?".
//
// `ambiguous:true` (accounts/categories) makes the startsWith + substring
// tiers FAIL LOUD on ≥2 candidates (issue #234) via a single-field filter.
// `ambiguous:false` (holdings) takes the first match per field in order and
// never returns an `ambiguous` result — matching the legacy holding resolver.
export type ResolveTier = string;
export type ResolveResult =
  | { ok: true; row: Row; tier: ResolveTier }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "low_confidence"; suggestion: Row }
  | { ok: false; reason: "ambiguous"; tier: ResolveTier; candidates: Row[] };

interface ResolveOpts {
  /** Exact-match fields, in priority order. e.g. [{field:"name",tier:"exact"}, {field:"alias",tier:"alias"}]. */
  exactFields: Array<{ field: string; tier: ResolveTier }>;
  /** startsWith fields, in priority order. */
  startsFields: Array<{ field: string; tier: ResolveTier }>;
  /** Field the token-overlap substring tier scans (always "name" for our three). */
  substringField: string;
  /** Tier label emitted for a substring hit. */
  substringTier: ResolveTier;
  /**
   * When true (accounts/categories): the startsWith + substring tiers use the
   * FIRST `startsFields`/substring field and FAIL LOUD on ≥2 matches. When
   * false (holdings): each field is tried in order via `.find` (first hit
   * wins) and ambiguity is never reported.
   */
  ambiguous: boolean;
}

export function resolveStrict(input: string, options: Row[], opts: ResolveOpts): ResolveResult {
  if (!input || !options.length) return { ok: false, reason: "missing" };
  const lo = input.toLowerCase().trim();
  // 1. Exact tiers, in order.
  // With `ambiguous:true` an exact match on ≥2 rows FAILS LOUD (holdings can
  // share an exact display name across accounts — FINLYNQ-267). Accounts/
  // categories have UNIQUE names so this stays a byte-identical first-hit for
  // them. With `ambiguous:false` (legacy) it keeps the first-hit `.find`.
  for (const { field, tier } of opts.exactFields) {
    if (opts.ambiguous) {
      const hits = options.filter(o => String(o[field] ?? "").toLowerCase() === lo);
      if (hits.length === 1) return { ok: true, row: hits[0], tier };
      if (hits.length >= 2) return { ok: false, reason: "ambiguous", tier, candidates: hits.slice(0, 5) };
    } else {
      const hit = options.find(o => String(o[field] ?? "").toLowerCase() === lo);
      if (hit) return { ok: true, row: hit, tier };
    }
  }
  // 2. startsWith tiers.
  if (opts.ambiguous) {
    // Single startsWith field, fail-loud on ties (issue #234).
    const { field, tier } = opts.startsFields[0];
    const starts = options.filter(o => {
      const n = String(o[field] ?? "").toLowerCase();
      return n !== "" && n.startsWith(lo);
    });
    if (starts.length === 1) return { ok: true, row: starts[0], tier };
    if (starts.length >= 2) return { ok: false, reason: "ambiguous", tier: "startsWith", candidates: starts.slice(0, 5) };
  } else {
    for (const { field, tier } of opts.startsFields) {
      const hit = options.find(o => {
        const n = String(o[field] ?? "").toLowerCase();
        return n !== "" && n.startsWith(lo);
      });
      if (hit) return { ok: true, row: hit, tier };
    }
  }
  // 3. Substring / reverse-substring tier — gate on token overlap.
  const tokenize = (s: string) =>
    new Set(s.split(/\s+/).map(t => t.replace(/[^a-z0-9]/g, "")).filter(t => t.length >= 3));
  const inputTokens = tokenize(lo);
  const sharesToken = (name: string) => {
    if (!inputTokens.size) return false;
    for (const t of tokenize(name)) if (inputTokens.has(t)) return true;
    return false;
  };
  const subField = opts.substringField;
  if (opts.ambiguous) {
    const subs = options.filter(o => {
      const n = String(o[subField] ?? "").toLowerCase();
      if (n === "") return false;
      if (!n.includes(lo) && !lo.includes(n)) return false;
      return sharesToken(n);
    });
    if (subs.length === 1) return { ok: true, row: subs[0], tier: opts.substringTier };
    if (subs.length >= 2) return { ok: false, reason: "ambiguous", tier: "substring", candidates: subs.slice(0, 5) };
  } else {
    const sub = options.find(o => {
      const n = String(o[subField] ?? "").toLowerCase();
      if (n === "") return false;
      if (!n.includes(lo) && !lo.includes(n)) return false;
      return sharesToken(n);
    });
    if (sub) return { ok: true, row: sub, tier: opts.substringTier };
  }
  // 4. No strong match — surface what fuzzyFind WOULD have matched.
  const legacy =
    options.find(o => String(o[subField] ?? "").toLowerCase().includes(lo)) ??
    options.find(o => {
      const n = String(o[subField] ?? "").toLowerCase();
      return n !== "" && lo.includes(n);
    });
  return legacy
    ? { ok: false, reason: "low_confidence", suggestion: legacy }
    : { ok: false, reason: "missing" };
}

// ─── named wrappers (byte-identical return shapes to the legacy resolvers) ──────

type AccountResolveTier = "exact" | "alias" | "startsWith" | "substring";
export type AccountResolveResult =
  | { ok: true; account: Row; tier: AccountResolveTier }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "low_confidence"; suggestion: Row }
  | { ok: false; reason: "ambiguous"; tier: ResolveTier; candidates: Row[] };
export function resolveAccountStrict(input: string, options: Row[]): AccountResolveResult {
  const r = resolveStrict(input, options, {
    exactFields: [{ field: "name", tier: "exact" }, { field: "alias", tier: "alias" }],
    startsFields: [{ field: "name", tier: "startsWith" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: true,
  });
  if (r.ok) return { ok: true, account: r.row, tier: r.tier as AccountResolveTier };
  return r;
}

type CategoryResolveTier = "exact" | "startsWith" | "substring";
export type CategoryResolveResult =
  | { ok: true; category: Row; tier: CategoryResolveTier }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "low_confidence"; suggestion: Row }
  | { ok: false; reason: "ambiguous"; tier: ResolveTier; candidates: Row[] };
export function resolveCategoryStrict(input: string, options: Row[]): CategoryResolveResult {
  const r = resolveStrict(input, options, {
    exactFields: [{ field: "name", tier: "exact" }],
    startsFields: [{ field: "name", tier: "startsWith" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: true,
  });
  if (r.ok) return { ok: true, category: r.row, tier: r.tier as CategoryResolveTier };
  return r;
}

type HoldingResolveTier = "exact-name" | "exact-symbol" | "startsWith-name" | "startsWith-symbol" | "substring";
export type HoldingResolveResult =
  | { ok: true; holding: Row; tier: HoldingResolveTier }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "low_confidence"; suggestion: Row };
export function resolvePortfolioHoldingStrict(input: string, options: Row[]): HoldingResolveResult {
  const r = resolveStrict(input, options, {
    exactFields: [{ field: "name", tier: "exact-name" }, { field: "symbol", tier: "exact-symbol" }],
    startsFields: [{ field: "name", tier: "startsWith-name" }, { field: "symbol", tier: "startsWith-symbol" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: false,
  });
  if (r.ok) return { ok: true, holding: r.row, tier: r.tier as HoldingResolveTier };
  // The generic can return "ambiguous" only when ambiguous:true; holdings pass
  // false, so the only failure shapes here are missing / low_confidence.
  return r as HoldingResolveResult;
}

// ─── shared name-resolution envelope (FINLYNQ-267) ──────────────────────────────
//
// ONE resolution path for every name-accepting MCP write tool: `resolveEntity`
// folds `id fast-path → strict match → envelope` and returns exactly one of
// three outcomes — never a silent zero:
//   • resolved   → an owned id to proceed with;
//   • ambiguous  → 2+ matches; the caller MUST disambiguate (never picks first);
//   • not_found  → zero matches; surfaced explicitly (never indistinguishable
//                  from an empty/"no link" result).
//
// The util is DEK-free and pure: the caller runs `decryptNameish` FIRST and
// passes already-decrypted `options` (invariant "decryptNameish before
// fuzzyFind"; issue #230). It builds ON `resolveStrict` (the length-≥3 token
// gate is the #123 low-confidence guard — reused verbatim, no new threshold).

export interface EntityCandidate {
  id: number;
  name: string | null; // decrypted (safeName-defended; a decrypted name can be null)
  symbol?: string | null;
  alias?: string | null;
  account?: string | null; // for holdings spanning accounts
}

export type ResolveEnvelope =
  | { status: "resolved"; id: number; via: "id" | ResolveTier }
  | { status: "ambiguous"; candidates: EntityCandidate[] } // 2+ matches — caller MUST disambiguate
  // zero match — never silent. `didYouMean` is a top-N ranked candidate list
  // (WITH ids), always populated when the user's inventory is non-empty so
  // EVERY family emits the SAME recovery affordance (FINLYNQ-273 — the bare
  // "matched no goal" shape gains suggestions-with-ids like categories/
  // holdings). `suggestion` is the single best legacy low-confidence hit,
  // kept for back-compat callers; it is always `didYouMean[0]` when present.
  | { status: "not_found"; warning: string; suggestion?: EntityCandidate; didYouMean?: EntityCandidate[] };

export type ResolveEntityType =
  | "account"
  | "category"
  | "holding"
  | "goal"
  | "loan"
  | "subscription"
  | "rule";

export interface ResolveEntityArgs {
  entity: ResolveEntityType;
  /** FK fast-path — WINS over `name` when a positive int (id is not even
   *  consulted against `name`; when both are passed, `name` is ignored). */
  id?: number | null;
  /** Human-readable name/alias/symbol to fuzzy-match when `id` is absent. */
  name?: string | null;
  /** Already-decrypted candidate rows. Caller runs `decryptNameish` first. */
  options: Row[];
  /** Per-entity strict config; defaults from DEFAULT_STRICT keyed on `entity`. */
  strict?: ResolveOpts;
}

/**
 * Per-entity `resolveStrict` config registry. Accounts/categories/goals/loans/
 * subscriptions all match on `name` (+ alias for accounts) with `ambiguous:true`
 * (fail loud on ties). Holdings match on name OR symbol and — the FINLYNQ-267
 * flip — now ALSO pass `ambiguous:true` so a name/symbol matching 2 positions
 * across accounts returns `ambiguous` instead of silently taking the first
 * (closing the legacy `ambiguous:false` first-hit-wins gap, row #27).
 */
export const DEFAULT_STRICT: Record<ResolveEntityType, ResolveOpts> = {
  account: {
    exactFields: [{ field: "name", tier: "exact" }, { field: "alias", tier: "alias" }],
    startsFields: [{ field: "name", tier: "startsWith" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: true,
  },
  category: {
    exactFields: [{ field: "name", tier: "exact" }],
    startsFields: [{ field: "name", tier: "startsWith" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: true,
  },
  holding: {
    exactFields: [{ field: "name", tier: "exact-name" }, { field: "symbol", tier: "exact-symbol" }],
    startsFields: [{ field: "name", tier: "startsWith-name" }, { field: "symbol", tier: "startsWith-symbol" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: true, // FINLYNQ-267 flip (was false — silent first-hit)
  },
  goal: {
    exactFields: [{ field: "name", tier: "exact" }],
    startsFields: [{ field: "name", tier: "startsWith" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: true,
  },
  loan: {
    exactFields: [{ field: "name", tier: "exact" }],
    startsFields: [{ field: "name", tier: "startsWith" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: true,
  },
  subscription: {
    exactFields: [{ field: "name", tier: "exact" }],
    startsFields: [{ field: "name", tier: "startsWith" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: true,
  },
  // FINLYNQ-273 — rules gain a name path on delete. Rule names are stored in the
  // `name` column (encrypted; decrypted via decryptRuleFields, NOT decryptNameish),
  // so the caller passes already-decrypted `{id, name}` rows.
  rule: {
    exactFields: [{ field: "name", tier: "exact" }],
    startsFields: [{ field: "name", tier: "startsWith" }],
    substringField: "name",
    substringTier: "substring",
    ambiguous: true,
  },
};

/**
 * FINLYNQ-273 — rank a candidate list top-N for a `not_found` "did you mean"
 * hint, WITH ids. Shares the ranking heuristic with `suggestionList` (startsWith
 * → substring → reverse-substring → edit distance) but returns structured
 * `EntityCandidate[]` (id-bearing) instead of a pre-joined string, so every
 * family's `not_found` envelope carries the SAME machine-readable recovery set.
 * Names only — no DEK here (options are already decrypted).
 */
export function rankCandidates(
  query: string,
  options: Row[],
  maxCount = 5,
): EntityCandidate[] {
  if (!options.length) return [];
  const lo = (query ?? "").toLowerCase().trim();
  const editDistance = (a: string, b: string): number => {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = a.length, n = b.length;
    let prev = new Array<number>(n + 1).fill(0);
    let cur = new Array<number>(n + 1).fill(0);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  };
  const scored = options
    .map((o) => {
      // Match on the primary display field (name) OR symbol (holdings) so a
      // ticker-shaped miss still surfaces the right row.
      const name = String(o.name ?? "").trim();
      const symbol = String(o.symbol ?? "").trim();
      const label = name || symbol;
      if (!label) return null;
      const lname = name.toLowerCase();
      const lsym = symbol.toLowerCase();
      let bucket = 3;
      if (lo && (lname.startsWith(lo) || (lsym && lsym.startsWith(lo)))) bucket = 0;
      else if (lo && (lname.includes(lo) || (lsym && lsym.includes(lo)))) bucket = 1;
      else if (lo && (lo.includes(lname) || (lsym && lo.includes(lsym)))) bucket = 2;
      const dist = lo ? Math.min(editDistance(lname, lo), lsym ? editDistance(lsym, lo) : Infinity) : 0;
      return { o, label, bucket, dist };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => (a.bucket - b.bucket) || (a.dist - b.dist) || a.label.localeCompare(b.label))
    .slice(0, maxCount);
  return scored.map((s) => toCandidate(s.o));
}

/** Coerce a resolve candidate/suggestion Row into an EntityCandidate (null-safe). */
function toCandidate(o: Row): EntityCandidate {
  return {
    id: Number(o.id),
    name: (o.name ?? null) as string | null,
    symbol: (o.symbol ?? null) as string | null,
    alias: (o.alias ?? null) as string | null,
    account: (o.account ?? null) as string | null,
  };
}

export function resolveEntity(args: ResolveEntityArgs): ResolveEnvelope {
  const { entity, id, name, options } = args;
  const strict = args.strict ?? DEFAULT_STRICT[entity];

  // 1. id fast-path — WINS over name; name is not even consulted.
  if (id != null && Number.isInteger(id) && id > 0) {
    const owned = options.find((o) => Number(o.id) === id);
    if (owned) return { status: "resolved", id, via: "id" };
    return { status: "not_found", warning: `${entity} id ${id} not found or not owned by you` };
  }

  // 2. empty name (and no usable id).
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    return { status: "not_found", warning: `no ${entity} name or id provided` };
  }

  // 3. strict match (exact → startsWith → token-gated substring → low_confidence).
  const r = resolveStrict(trimmed, options, strict);
  if (r.ok) return { status: "resolved", id: Number(r.row.id), via: r.tier };
  if (r.reason === "ambiguous") {
    return { status: "ambiguous", candidates: r.candidates.map(toCandidate) };
  }
  // FINLYNQ-273 — a not_found ALWAYS carries a top-N `didYouMean` (WITH ids) when
  // the inventory is non-empty, so every family emits the SAME recovery affordance
  // (was: `low_confidence` returned one `suggestion`, `missing` returned bare).
  // The best low-confidence hit (if any) is promoted to the head of the list so
  // `suggestion === didYouMean[0]`.
  const ranked = rankCandidates(trimmed, options);
  if (r.reason === "low_confidence") {
    const best = toCandidate(r.suggestion);
    const didYouMean = [best, ...ranked.filter((c) => c.id !== best.id)].slice(0, 5);
    return {
      status: "not_found",
      warning: `'${trimmed}' had no confident ${entity} match`,
      suggestion: best,
      didYouMean,
    };
  }
  return {
    status: "not_found",
    warning: `'${trimmed}' matched no ${entity}`,
    ...(ranked.length ? { suggestion: ranked[0], didYouMean: ranked } : {}),
  };
}

/**
 * FINLYNQ-273 — SINGLE source of truth for rendering a non-resolved envelope as
 * a human message, so every family's ambiguous / not_found error reads
 * IDENTICALLY (candidates WITH ids in both cases). `resolveOrReport` wraps this
 * in an `err(...)`; the category preview/merge path throws it as a
 * `PreviewAbortError`. Returns `null` for a `resolved` envelope (nothing to say).
 */
export function formatResolveFailure(label: string, env: ResolveEnvelope): string | null {
  if (env.status === "resolved") return null;
  if (env.status === "ambiguous") {
    const list = env.candidates
      .map((c) => (c.symbol ? `"${c.name}" (${c.symbol}, id=${c.id})` : `"${c.name}" (id=${c.id})`))
      .join(", ");
    return `${label} is ambiguous — ${env.candidates.length} matches: ${list}. Pass ${label}_id to disambiguate.`;
  }
  // not_found — prefer the full top-N didYouMean list (ids); fall back to the
  // single suggestion; bare when the inventory has no candidates at all.
  const list = env.didYouMean?.length
    ? env.didYouMean.map((c) => (c.symbol ? `"${c.name}" (${c.symbol}, id=${c.id})` : `"${c.name}" (id=${c.id})`)).join(", ")
    : env.suggestion
      ? `"${env.suggestion.name}" (id=${env.suggestion.id})`
      : "";
  const hint = list ? ` Did you mean: ${list}?` : "";
  return `${env.warning}.${hint}`;
}

/**
 * Envelope → "resolve, and if it didn't cleanly resolve, RETURN an MCP error
 * now" so each callsite is 3 lines. Returns `{id}` on success or `{report}`
 * holding a ready-to-return `err(...)` tool response on ambiguous/not_found.
 */
export function resolveOrReport(
  label: string,
  env: ResolveEnvelope,
): { id: number } | { report: ReturnType<typeof err> } {
  if (env.status === "resolved") return { id: env.id };
  // FINLYNQ-273 — the message is single-sourced in `formatResolveFailure` so
  // ambiguous / not_found read identically across every family (candidates
  // WITH ids in both cases).
  return { report: err(formatResolveFailure(label, env)!) };
}

/**
 * Multi-name aggregation helper (rebalancer `targets[]`,
 * `get_portfolio_analysis` `symbols[]`): collect each `not_found` into a
 * response-level `warnings: string[]` (byte-identical to FINLYNQ-252 / #86)
 * WITHOUT short-circuiting. Ambiguous cases surface per-entry via the caller.
 */
export function collectWarnings(
  entries: Array<{ label: string; env: ResolveEnvelope }>,
): string[] {
  const warnings: string[] = [];
  for (const { label, env } of entries) {
    if (env.status === "not_found") {
      const hint = env.suggestion ? ` Did you mean "${env.suggestion.name}" (id=${env.suggestion.id})?` : "";
      warnings.push(`${env.warning} for '${label}'.${hint}`);
    }
  }
  return warnings;
}

export function decryptNameish(rows: Row[], dek: Buffer | null): Row[] {
  if (!rows.length) return rows;
  return rows.map((r) => {
    const out: Row = { ...r };
    const nameCt = (r.name_ct ?? r.nameCt) as string | null | undefined;
    const aliasCt = (r.alias_ct ?? r.aliasCt) as string | null | undefined;
    const symbolCt = (r.symbol_ct ?? r.symbolCt) as string | null | undefined;
    if (nameCt && nameCt !== "") {
      out.name = dek ? decryptField(dek, nameCt) : nameCt;
    }
    if (aliasCt !== undefined && aliasCt !== null && aliasCt !== "") {
      out.alias = dek ? decryptField(dek, aliasCt) : aliasCt;
    }
    if (symbolCt !== undefined && symbolCt !== null && symbolCt !== "") {
      out.symbol = dek ? decryptField(dek, symbolCt) : symbolCt;
    }
    return out;
  });
}

/**
 * Stream D write-side helper: produce `{ nameCt, nameLookup }` etc. from a
 * field map. Returns an empty object when `dek` is null (no DEK, stdio MCP)
 * — callers still write plaintext, backfill encrypts on next login.
 */
export function buildCtLookup(
  dek: Buffer | null,
  fields: Record<string, string | null | undefined>,
): Record<string, string | null> {
  if (!dek) return {};
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    const { ct, lookup } = encryptName(dek, value);
    out[key + "Ct"] = ct;
    out[key + "Lookup"] = lookup;
  }
  return out;
}

export async function autoCategory(
  db: DbLike,
  userId: string,
  payee: string,
  dek: Buffer | null,
  isInvestmentAccount: boolean = false,
  // When true, the investment dividend/interest pass may CREATE the canonical
  // category if the user has none. MUST be false on dryRun (preview) paths —
  // a dry run must not write to the DB.
  allowCreate: boolean = false,
): Promise<number | null> {
  if (!payee) return null;

  // Investment-account mode pre-loads (id, name, type) for every category so
  // the rule loop can drop expense matches and the keyword pattern +
  // fallback can resolve well-known names ("Dividends", "Transfers"). Names
  // may be Stream-D-encrypted; decrypt with the same ct → plaintext-fallback
  // ladder used elsewhere (Phase-3 / pathfinder DEK-mismatch resilient).
  let catTypeById: Map<number, string> | null = null;
  let investmentHints: InvestmentCategoryHint[] | null = null;
  if (isInvestmentAccount) {
    // Stream D Phase 4 — plaintext name dropped; ciphertext only.
    const rawCats = await q(db, sql`
      SELECT id, name_ct, type FROM categories WHERE user_id = ${userId}
    `);
    catTypeById = new Map();
    investmentHints = [];
    for (const r of rawCats) {
      const id = Number(r.id);
      const type = String(r.type ?? "");
      catTypeById.set(id, type);
      const nm: string = r.name_ct && dek ? (decryptField(dek, String(r.name_ct)) ?? "") : "";
      if (nm) investmentHints.push({ id, name: nm, type });
    }
  }

  // FINLYNQ-84: rules now carry JSONB conditions + actions. We use the
  // shared matcher (matchesRule + computePureActionPatch) so the MCP write
  // path stays aligned with the REST/import-pipeline definition of "match".
  //
  // For the autoCategory helper (used by record_transaction etc.) we only
  // resolve set_category from the matched rule's pure-action patch — any
  // other actions belong to the approve-time path. Rules whose only action
  // is rename_payee / set_tags / set_entered_currency / set_portfolio_holding
  // / set_account / create_transfer are IGNORED here.
  const rawRules = await q(db, sql`
    SELECT id, name, conditions, actions, priority
      FROM transaction_rules
     WHERE user_id = ${userId}
       AND is_active = true
     ORDER BY priority DESC
  `);
  const parsedRules = rawRules.map((r) => ({
    id: Number(r.id),
    name: String(r.name ?? ""),
    conditions: (r.conditions ?? { all: [] }) as { all: unknown[] },
    actions: (Array.isArray(r.actions) ? r.actions : []) as Array<{ kind: string; categoryId?: number }>,
    isActive: true,
    priority: Number(r.priority ?? 0),
  }));
  // Inline lightweight matcher — duplicates auto-categorize's matchesRule
  // shape for the stdio-compat case where we don't have date/account in scope.
  function matchesPayeeOnly(payee: string, conditions: { all: unknown[] }): boolean {
    const conds = conditions.all ?? [];
    if (conds.length === 0) return false;
    return conds.every((c: unknown) => {
      const cond = c as { field?: string; op?: string; value?: string };
      // Only payee/note/tags string predicates evaluate against payee alone.
      // Any other condition kind fails fast (we don't have the data here).
      if (cond.field !== "payee" && cond.field !== "tags" && cond.field !== "note") return false;
      if (cond.field !== "payee") return false; // autoCategory: payee-only scope
      const v = String(cond.value ?? "");
      const a = payee.toLowerCase();
      const b = v.toLowerCase();
      if (cond.op === "contains") return a.includes(b);
      if (cond.op === "exact") return a === b;
      if (cond.op === "regex") {
        try { return new RegExp(v, "i").test(payee); }
        catch { return false; }
      }
      return false;
    });
  }
  function ruleSetCategoryId(actions: Array<{ kind: string; categoryId?: number }>): number | null {
    for (const a of actions) {
      if (a.kind === "set_category" && typeof a.categoryId === "number") return a.categoryId;
    }
    return null;
  }

  // ── Investment-account branch ────────────────────────────────────────────
  // Run the investment-only ladder and return early.
  if (isInvestmentAccount) {
    // 1. Investment-aware rules — expense rules are skipped, next priority gets a chance.
    for (const rule of parsedRules) {
      if (!matchesPayeeOnly(payee, rule.conditions)) continue;
      const cid = ruleSetCategoryId(rule.actions);
      if (cid == null) continue;
      if (catTypeById?.get(cid) === "E") continue;
      return cid;
    }
    // 2. Keyword pattern pass (Dividend / Interest / Forex / Disbursement).
    if (investmentHints) {
      const id = pickInvestmentCategoryByPayee(payee, investmentHints);
      if (id !== null) return id;
    }
    // 2b. Create-if-missing for dividend / interest payees. The keyword pass
    //     above is lookup-only, so an MCP-recorded dividend on a user with no
    //     "Dividends" category silently dropped out of the Dividend Income
    //     report. Resolve-or-create the canonical category so it reports.
    //     Gated on allowCreate so dryRun previews never write.
    if (allowCreate) {
      const lower = payee.toLowerCase();
      const incomeKind = lower.includes("dividend")
        ? ("dividend" as const)
        : lower.includes("interest")
          ? ("interest" as const)
          : null;
      if (incomeKind) {
        const id = await resolveOrCreateInvestmentIncomeCategory(
          db,
          userId,
          dek,
          incomeKind,
        );
        if (id !== null) return id;
      }
    }
    // 3. Fallback — prefers "Transfers" / "Investment Activity".
    if (investmentHints) {
      const fb = fallbackInvestmentCategory(investmentHints);
      if (fb !== null) return fb;
    }
    return null;
  }

  // ── Non-investment branch ────────────────────────────────────────────────
  for (const rule of parsedRules) {
    if (!matchesPayeeOnly(payee, rule.conditions)) continue;
    const cid = ruleSetCategoryId(rule.actions);
    if (cid != null) return cid;
  }

  // Historical-frequency match (non-investment only).
  let histId: number | null = null;
  if (!dek) {
    // Legacy plaintext-only fallback
    const hist = await q(db, sql`
      SELECT category_id, COUNT(*) as cnt FROM transactions
      WHERE user_id = ${userId} AND LOWER(payee) = LOWER(${payee}) AND category_id IS NOT NULL
      GROUP BY category_id ORDER BY cnt DESC LIMIT 1
    `);
    if (hist.length) {
      histId = Number(hist[0].category_id);
    }
  } else {
    // Fetch candidate rows with category, decrypt payee, then tally.
    const rows = await q(db, sql`
      SELECT payee, category_id FROM transactions
      WHERE user_id = ${userId} AND category_id IS NOT NULL AND payee IS NOT NULL AND payee <> ''
      ORDER BY date DESC, id DESC
      LIMIT 5000
    `);
    const target = payee.toLowerCase();
    const counts = new Map<number, number>();
    for (const r of rows) {
      const p = decryptField(dek, String(r.payee ?? ""));
      if (!p) continue;
      if (p.toLowerCase() === target) {
        const cid = Number(r.category_id);
        counts.set(cid, (counts.get(cid) ?? 0) + 1);
      }
    }
    let bestCnt = 0;
    for (const [id, cnt] of counts) {
      if (cnt > bestCnt) {
        bestCnt = cnt;
        histId = id;
      }
    }
  }
  if (histId !== null) return histId;

  return null;
}

/**
 * Look up a portfolio_holdings row by NAME OR TICKER SYMBOL for the given
 * user. Lookup-only — NEVER auto-creates (auto-create is the import pipeline's
 * job; MCP callers use add_portfolio_holding for that).
 *
 * Matching is HMAC-only after Stream D Phase 4 (2026-05-03) physically dropped
 * the plaintext `name`/`symbol` columns:
 *   - HMAC `name_lookup`   match (covers both "Acme Corp" and "ACME")
 *   - HMAC `symbol_lookup` match (covers ticker-style input)
 *
 * The same `nameLookup(dek, trimmed)` HMAC value is checked against both
 * `name_lookup` and `symbol_lookup` columns since the HMAC is computed over
 * trimmed-lowercase input regardless of whether that input is a name or
 * ticker. Ergonomic for write tools where users naturally say "HURN"
 * instead of the full company name.
 *
 * When `accountId` is set, the lookup is scoped to that account — disambiguates
 * the same name/ticker in two brokerages. The `(user_id, account_id, name_lookup)`
 * partial UNIQUE makes per-account matches unambiguous; without scoping, two
 * accounts with the same-named holding return an ambiguity error.
 *
 * Requires `dek` (HTTP MCP is auth-gated; DEK is always present). Returns
 * a clean error if `dek` is null rather than running a query that would
 * never match.
 */
export async function resolvePortfolioHoldingByName(
  db: DbLike,
  userId: string,
  name: string,
  dek: Buffer | null,
  accountId?: number,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "portfolioHolding cannot be empty" };

  if (!dek) {
    return {
      ok: false,
      error: `Cannot resolve holding "${trimmed}" without an unlocked DEK. Pass portfolioHoldingId directly, or unlock the session.`,
    };
  }

  const lookup = nameLookup(dek, trimmed);
  const accountFilter = accountId ? sql`AND account_id = ${accountId}` : sql``;
  const matches = await q(db, sql`
    SELECT id
      FROM portfolio_holdings
     WHERE user_id = ${userId}
       AND (name_lookup = ${lookup} OR symbol_lookup = ${lookup})
       ${accountFilter}
     LIMIT 5
  `);

  if (matches.length === 0) {
    // Surface candidate "name (TICKER)" entries so the agent can retry with a
    // valid identifier. Decrypt name_ct + symbol_ct under DEK.
    const allRaw = await q(db, sql`
      SELECT id, name_ct, symbol_ct
        FROM portfolio_holdings
       WHERE user_id = ${userId}
       ${accountFilter}
       LIMIT 20
    `);
    const candidates = allRaw
      .map((r) => {
        let nm: string | null = null;
        if (r.name_ct) {
          try { nm = decryptField(dek, String(r.name_ct)); } catch { nm = null; }
        }
        if (!nm) return null;
        let sym: string | null = null;
        if (r.symbol_ct) {
          try { sym = decryptField(dek, String(r.symbol_ct)); } catch { sym = null; }
        }
        return sym ? `${nm} (${sym})` : nm;
      })
      .filter((n): n is string => Boolean(n));
    return {
      ok: false,
      error: `Holding "${trimmed}" not found${accountId ? " in this account" : ""}.${candidates.length ? ` Candidates (name (ticker)): ${candidates.slice(0, 10).join(", ")}.` : ""} Use add_portfolio_holding to create a new one.`,
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: `Holding "${trimmed}" is ambiguous (${matches.length} matches: ids ${matches.map((m) => m.id).join(", ")}). ${accountId ? "Even within the resolved account" : "Pass `account` to scope the lookup"}, or pass portfolioHoldingId directly.`,
    };
  }

  return { ok: true, id: Number(matches[0].id) };
}

export const PORTFOLIO_DISCLAIMER =
  "⚠️ DISCLAIMER: This analysis is for informational purposes only and does not constitute financial advice. Past performance is not indicative of future results. Consult a qualified financial advisor before making investment decisions.";

/**
 * Decrypt the text fields on a transaction row in place. Tolerates legacy
 * plaintext rows (values without the `v1:` prefix pass through unchanged)
 * and missing DEK (returns the row untouched so legacy API keys still work
 * for plaintext data).
 */
export function decryptTxRowFields(
  dek: Buffer | null | undefined,
  row: Record<string, unknown>
): Record<string, unknown> {
  if (!dek) return row;
  for (const k of ["payee", "note", "tags"] as const) {
    const v = row[k];
    if (typeof v === "string") {
      row[k] = decryptField(dek, v) ?? v;
    }
  }
  return row;
}


/** Issue #65: shift an ISO YYYY-MM-DD date by N days (UTC-safe). Returns null on parse failure. */
export function shiftIsoDate(iso: string, deltaDays: number): string | null {
  const ms = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + deltaDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

