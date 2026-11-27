import { NextRequest, NextResponse } from "next/server";
import { db, schema, withDbTransaction } from "@/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { z } from "zod";
import { validateBody, safeErrorMessage, AppError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows, encryptOptional, decryptOptional } from "@/lib/crypto/encrypted-columns";
import { computeGoalProgress } from "@/lib/goals-progress";
import { GOAL_PROGRESS_MODES, growthGoalRefusal, normalizeProgressMode } from "@/lib/goals/progress-mode";
import { todayISO } from "@/lib/utils/date";
import { getDisplayCurrency, getRateMap, convertWithRateMap } from "@/lib/fx-service";
import { pickRecordCurrency } from "@/lib/fx/record-currency";
import { isPgErrorCode, pgErrorConstraint } from "@/lib/db-utils";
import {
  GOAL_ALLOCATION_KINDS,
  allocationRefusal,
  readAllocation,
  summarizeAccountClaims,
  type GoalAllocation,
  type AccountClaimRow,
} from "@/lib/goals/allocation";

/**
 * Goal names are unique per user (`goals_user_name_lookup_uniq` over the
 * name_lookup HMAC). Creating or renaming onto a taken name is ordinary user
 * behaviour: answer 409 with a clear message, not a 500 "Failed" (prod
 * diagnostics_log 2026-11-22 06:35). Same shape as the accounts route.
 */
function duplicateNameResponse(error: unknown): NextResponse | null {
  if (!isPgErrorCode(error, "23505")) return null;
  const constraint = pgErrorConstraint(error);
  if (constraint && constraint !== "goals_user_name_lookup_uniq") return null;
  return NextResponse.json(
    { error: "A goal with this name already exists. Pick a different name." },
    { status: 409 },
  );
}

// GH #462: one linked account with how much of it the goal counts. No kind =
// the whole account. Percent 0 < v <= 100, amount > 0 (goal currency).
const accountLinkSchema = z
  .object({
    accountId: z.number().int(),
    allocationKind: z.enum(GOAL_ALLOCATION_KINDS).nullable().optional(),
    allocationValue: z.number().nullable().optional(),
  })
  .superRefine((l, ctx) => {
    const refusal = allocationRefusal(l.allocationKind, l.allocationValue);
    if (refusal) ctx.addIssue({ code: "custom", message: refusal, path: ["allocationValue"] });
  });

const postSchema = z.object({
  name: z.string(),
  type: z.string(),
  targetAmount: z.number(),
  currency: z.string().regex(/^[A-Z]{3,4}$/, "ISO currency code").optional(),
  deadline: z.string().optional(),
  accountId: z.number().optional(),
  // Issue #130 — multi-account linking. When supplied, replaces the legacy
  // single-account `accountId` semantics. Empty array means "unlinked".
  accountIds: z.array(z.number()).optional(),
  // GH #462: linked accounts WITH allocations. Wins over accountIds/accountId.
  accountLinks: z.array(accountLinkSchema).optional(),
  priority: z.number().optional(),
  status: z.string().optional(),
  note: z.string().optional(),
  // GH #423: 'balance' (default) or 'growth' since startDate.
  progressMode: z.enum(GOAL_PROGRESS_MODES).optional(),
  startDate: z.string().nullable().optional(),
});

const putSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  type: z.string().optional(),
  targetAmount: z.number().optional(),
  currency: z.string().regex(/^[A-Z]{3,4}$/, "ISO currency code").optional(),
  deadline: z.string().optional(),
  accountId: z.number().optional(),
  accountIds: z.array(z.number()).optional(),
  accountLinks: z.array(accountLinkSchema).optional(),
  priority: z.number().optional(),
  status: z.string().optional(),
  note: z.string().optional(),
  // GH #423: 'balance' (default) or 'growth' since startDate.
  progressMode: z.enum(GOAL_PROGRESS_MODES).optional(),
  startDate: z.string().nullable().optional(),
});

type ResolvedLink = { accountId: number; allocation: GoalAllocation | null };

/**
 * Resolve the canonical list of account ids for a goal write. Accepts the
 * new `accountIds` array (preferred), falls back to legacy single
 * `accountId`. Returns:
 *   - `null` when neither is supplied (caller should leave links untouched
 *     on PUT, or default to none on POST)
 *   - `[]` when `accountIds: []` was supplied (explicit "unlink all")
 *   - `[id, id, ...]` when ids were supplied
 */
function resolveAccountIds(
  body: { accountId?: number | null | undefined; accountIds?: number[] | undefined },
): number[] | null {
  if (body.accountIds !== undefined) return body.accountIds;
  if (body.accountId != null) return [body.accountId];
  return null;
}

/**
 * GH #462: the links to write, with allocations. `accountLinks` wins over
 * `accountIds` / `accountId` (which link whole accounts, as before). Same
 * null / [] / list contract as `resolveAccountIds`. Throws AppError on an
 * account listed twice (the join is unique per goal + account).
 */
function resolveLinks(body: {
  accountId?: number | null | undefined;
  accountIds?: number[] | undefined;
  accountLinks?:
    | Array<{ accountId: number; allocationKind?: GoalAllocation["kind"] | null; allocationValue?: number | null }>
    | undefined;
}): ResolvedLink[] | null {
  if (body.accountLinks !== undefined) {
    const seen = new Set<number>();
    for (const l of body.accountLinks) {
      if (seen.has(l.accountId)) throw new AppError(`Account id ${l.accountId} is listed twice.`);
      seen.add(l.accountId);
    }
    return body.accountLinks.map((l) => ({
      accountId: l.accountId,
      allocation: readAllocation(l.allocationKind, l.allocationValue),
    }));
  }
  const ids = resolveAccountIds(body);
  if (ids === null) return null;
  return Array.from(new Set(ids)).map((accountId) => ({ accountId, allocation: null }));
}

function linkRows(userId: string, goalId: number, links: ResolvedLink[]) {
  return links.map((l) => ({
    userId,
    goalId,
    accountId: l.accountId,
    allocationKind: l.allocation?.kind ?? null,
    allocationValue: l.allocation?.value ?? null,
  }));
}

/**
 * Verify every supplied account id belongs to the user. Throws on mismatch
 * — same risk pattern as backup-restore FK remap (CLAUDE.md "Backup-restore
 * must remap FKs").
 */
async function verifyAccountOwnership(userId: string, accountIds: number[]): Promise<void> {
  if (!accountIds.length) return;
  const owned = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), inArray(schema.accounts.id, accountIds)));
  if (owned.length !== new Set(accountIds).size) {
    const ownedIds = new Set(owned.map((a) => a.id));
    const missing = accountIds.filter((id) => !ownedIds.has(id));
    throw new AppError(`Account id(s) not owned by user: ${missing.join(", ")}`);
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  // Stream D Phase 4 — plaintext `name`/`accountName` columns dropped.
  // Read ciphertext only and decrypt below.
  const rawGoals = await db
    .select({
      id: schema.goals.id,
      nameCt: schema.goals.nameCt,
      type: schema.goals.type,
      targetAmount: schema.goals.targetAmount,
      currency: schema.goals.currency,
      deadline: schema.goals.deadline,
      accountId: schema.goals.accountId,
      priority: schema.goals.priority,
      status: schema.goals.status,
      note: schema.goals.note,
      progressMode: schema.goals.progressMode,
      startDate: schema.goals.startDate,
    })
    .from(schema.goals)
    .where(eq(schema.goals.userId, userId))
    .orderBy(schema.goals.priority);

  // Pull every (goal_id, account_id, account_name_ct) link in one query and
  // group by goal id so the response carries `accountIds: number[]` and
  // decrypted `accounts: string[]` (issue #130).
  const goalIds = rawGoals.map((g) => g.id);
  const links: Array<{
    goalId: number;
    accountId: number;
    accountNameCt: string | null;
    allocationKind: string | null;
    allocationValue: number | null;
  }> =
    goalIds.length > 0
      ? await db
          .select({
            goalId: schema.goalAccounts.goalId,
            accountId: schema.goalAccounts.accountId,
            accountNameCt: schema.accounts.nameCt,
            allocationKind: schema.goalAccounts.allocationKind,
            allocationValue: schema.goalAccounts.allocationValue,
          })
          .from(schema.goalAccounts)
          .leftJoin(schema.accounts, eq(schema.goalAccounts.accountId, schema.accounts.id))
          .where(
            and(
              eq(schema.goalAccounts.userId, userId),
              inArray(schema.goalAccounts.goalId, goalIds),
            ),
          )
      : [];

  // Decrypt the per-link account name; group by goal.
  const linksDecrypted = decryptNamedRows(links, auth.context.dek, {
    accountNameCt: "accountName",
  }) as Array<typeof links[number] & { accountName: string | null }>;
  const linksByGoal = new Map<
    number,
    { ids: number[]; names: string[]; allocations: Record<number, GoalAllocation | null> }
  >();
  for (const link of linksDecrypted) {
    const entry = linksByGoal.get(link.goalId) ?? { ids: [], names: [], allocations: {} };
    entry.ids.push(link.accountId);
    entry.names.push(link.accountName ?? "");
    entry.allocations[link.accountId] = readAllocation(link.allocationKind, link.allocationValue);
    linksByGoal.set(link.goalId, entry);
  }

  const goalsDecrypted = decryptNamedRows(rawGoals, auth.context.dek, {
    nameCt: "name",
  }) as Array<typeof rawGoals[number] & { name: string | null }>;
  const goals = goalsDecrypted
    .map((g) => {
      const linked = linksByGoal.get(g.id);
      const accountIds = linked?.ids ?? [];
      const accounts = linked?.names ?? [];
      return {
        ...g,
        // Free-text note is user-DEK encrypted at rest (2026-06-01).
        note: decryptOptional(auth.context.dek, g.note),
        accountIds,
        accounts,
        // Legacy compat — first linked account name. Existing UI consumers
        // can switch to `accounts: string[]` at their leisure.
        accountName: accounts[0] ?? null,
      };
    })
    .sort((a, b) => {
      const pa = a.priority ?? 1;
      const pb = b.priority ?? 1;
      if (pa !== pb) return pa - pb;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });

  // Calculate current amount summed across ALL linked accounts (issue #130).
  // JOIN grain is `(goal_id, account_id, user_id)` — see CLAUDE.md.
  //
  // Issue #233: extracted into the shared `computeGoalProgress` helper so the
  // MCP HTTP `get_goals` tool can return the same progress numbers as REST.
  // Per-account branching on `accounts.is_investment` (CLAUDE.md issue #151)
  // and per-currency FX into the goal currency (issue #129) are owned by the
  // helper.
  const progressByGoal = await computeGoalProgress(
    userId,
    auth.context.dek,
    goals.map((g) => ({
      id: g.id,
      type: g.type,
      currency: g.currency ?? null,
      targetAmount: g.targetAmount,
      deadline: g.deadline ?? null,
      accountIds: g.accountIds,
      progressMode: g.progressMode,
      startDate: g.startDate ?? null,
      allocations: linksByGoal.get(g.id)?.allocations,
    })),
  );

  // GH #462: per account, what every ACTIVE goal claims of it against what it
  // holds (account currency). Liabilities are left out: no goal "claims" a
  // debt. A warning only; a balance can always drop below the claims.
  const claimRows: AccountClaimRow[] = [];
  for (const g of goals) {
    if ((g.status ?? "active") !== "active") continue;
    for (const l of progressByGoal.get(g.id)?.links ?? []) {
      if (l.accountIsLiability) continue;
      claimRows.push({
        accountId: l.accountId,
        goalId: g.id,
        balance: l.accountBalance,
        claim: l.claim,
        percent: l.claimPercent,
      });
    }
  }
  const claimsByAccount = summarizeAccountClaims(claimRows);

  // FINLYNQ-123 dual basis: every amount above is in the GOAL's own currency
  // (that is what `computeGoalProgress` measures in). Each row also carries a
  // current-rate conversion into the display currency so the page can total a
  // mixed-currency set of goals — summing the native figures under one symbol
  // is the same bug the loans page shipped.
  const displayCurrency = await getDisplayCurrency(
    userId,
    request.nextUrl.searchParams.get("currency"),
  );
  const rateMap = await getRateMap(displayCurrency, userId);
  const toDisplay = (amount: number, from: string | null) =>
    Math.round(convertWithRateMap(amount, from ?? displayCurrency, rateMap) * 100) / 100;

  const withProgress = goals.map((g) => {
    const p = progressByGoal.get(g.id);
    const currentAmount = p?.currentAmount ?? 0;
    return {
      ...g,
      currentAmount,
      progress: p?.progress ?? 0,
      // Issue #233: alias `percentComplete` matches the MCP `get_goals`
      // docstring's "with progress" promise. Same number as `progress`.
      percentComplete: p?.progress ?? 0,
      remaining: p?.remaining ?? g.targetAmount,
      monthlyNeeded: p?.monthlyNeeded ?? 0,
      progressMode: normalizeProgressMode(g.progressMode),
      // Growth goals: the linked balance at the start, and now (goal currency).
      startAmount: p?.startAmount ?? null,
      balanceNow: p?.balanceNow ?? currentAmount,
      displayCurrency,
      targetAmountDisplay: toDisplay(g.targetAmount, g.currency),
      currentAmountDisplay: toDisplay(currentAmount, g.currency),
      // GH #462: each linked account with its allocation, what it counts toward
      // this goal (goal currency), and the account-wide claim summary
      // (account currency; null for a liability or an account no active goal
      // links). Same account => same `claims` figures on every goal.
      accountLinks: (p?.links ?? []).map((l) => {
        const idx = g.accountIds.indexOf(l.accountId);
        const c = claimsByAccount.get(l.accountId);
        return {
          accountId: l.accountId,
          accountName: idx >= 0 ? g.accounts[idx] ?? "" : "",
          allocationKind: l.allocationKind,
          allocationValue: l.allocationValue,
          allocationApplied: l.allocationApplied,
          countedAmount: l.countedAmount,
          accountCurrency: l.accountCurrency,
          accountBalance: l.accountBalance,
          claims: c
            ? {
                claimed: c.claimed,
                unallocated: c.unallocated,
                percentClaimed: c.percentClaimed,
                overAllocated: c.overAllocated,
                goalCount: c.goalIds.length,
              }
            : null,
        };
      }),
    };
  });

  return NextResponse.json(withProgress);
}

export async function POST(request: NextRequest) {
  // requireEncryption, not requireAuth: buildNameFields(null) returns {} and
  // encryptOptional(null, note) stores the note as PLAINTEXT — a DEK-less
  // write persisted a permanently nameless row (review 2026-07-30 #7).
  const auth = await requireEncryption(request); if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    let links: ResolvedLink[];
    try {
      links = resolveLinks(d) ?? [];
    } catch (e) {
      return NextResponse.json({ error: safeErrorMessage(e, "Invalid account links") }, { status: 400 });
    }
    const accountIds = links.map((l) => l.accountId);
    try {
      await verifyAccountOwnership(userId, accountIds);
    } catch (e) {
      return NextResponse.json({ error: safeErrorMessage(e, "Invalid account") }, { status: 400 });
    }
    const progressMode = d.progressMode ?? "balance";
    const startDate = progressMode === "growth" ? d.startDate || null : null;
    const modeRefusal = growthGoalRefusal({ progressMode, startDate, accountIds, today: todayISO() });
    if (modeRefusal) return NextResponse.json({ error: modeRefusal }, { status: 400 });
    // Currency resolution (feedback #7): explicit > first linked account >
    // display currency. The web form always sends one, but the REST API is
    // public (mobile, API-key callers) and omitting it let the column default
    // stamp CAD onto a USD user's goal.
    let accountCurrency: string | null = null;
    if (accountIds.length > 0) {
      const acct = await db
        .select({ currency: schema.accounts.currency })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, accountIds[0]), eq(schema.accounts.userId, userId)))
        .get();
      accountCurrency = acct?.currency ?? null;
    }
    const currency = pickRecordCurrency({
      explicit: d.currency,
      accountCurrency,
      displayCurrency: await getDisplayCurrency(userId),
    });
    const enc = buildNameFields(dek, { name: d.name });
    // Stream D Phase 4 — plaintext `name` column dropped; only encrypted
    // siblings persist. Issue #130: dual-write `goals.account_id` (first id
    // only, legacy fallback) and the `goal_accounts` join.
    // The goal row and its `goal_accounts` links are ONE fact — a goal that
    // committed without its links tracks zero accounts and reports $0 progress
    // (review API-M2). `withDbTransaction` binds both writes to one connection.
    const newId = await withDbTransaction(async () => {
      const inserted = await db.insert(schema.goals).values({
        userId,
        type: d.type,
        targetAmount: d.targetAmount,
        currency,
        deadline: d.deadline || null,
        accountId: accountIds[0] ?? null,
        priority: d.priority ?? 1,
        status: d.status ?? "active",
        note: encryptOptional(dek, d.note) ?? "",
        progressMode,
        startDate,
        ...enc,
      }).returning({ id: schema.goals.id });
      const id = inserted[0]?.id;
      if (id && links.length > 0) {
        await db.insert(schema.goalAccounts).values(linkRows(userId, id, links));
      }
      return id;
    });
    // Re-read the row so the response carries the canonical shape.
    const goal = newId
      ? (await db.select().from(schema.goals).where(eq(schema.goals.id, newId)))[0]
      : null;
    return NextResponse.json(
      {
        ...goal,
        accountIds,
        accountLinks: links.map((l) => ({
          accountId: l.accountId,
          allocationKind: l.allocation?.kind ?? null,
          allocationValue: l.allocation?.value ?? null,
        })),
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    const duplicate = duplicateNameResponse(error);
    if (duplicate) return duplicate;
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  // requireEncryption — with a null DEK the rename silently no-ops and the note
  // lands in plaintext (review 2026-07-30 #7).
  const auth = await requireEncryption(request); if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const {
      id,
      name,
      accountId: _legacyAccountId,
      accountIds: _newAccountIds,
      accountLinks: _accountLinks,
      ...data
    } = parsed.data;
    void _legacyAccountId; void _newAccountIds; void _accountLinks;
    const toEncrypt: Record<string, string | null | undefined> = {};
    if (name !== undefined) toEncrypt.name = name;
    const enc = buildNameFields(dek, toEncrypt);
    if (data.currency) data.currency = data.currency.toUpperCase();

    // Did the caller intend to change account links? Only touch the join
    // when explicitly supplied — passing neither leaves links alone.
    let replaceLinks: ResolvedLink[] | null;
    try {
      replaceLinks = resolveLinks(parsed.data);
    } catch (e) {
      return NextResponse.json({ error: safeErrorMessage(e, "Invalid account links") }, { status: 400 });
    }
    const replaceAccountIds = replaceLinks ? replaceLinks.map((l) => l.accountId) : null;
    if (replaceAccountIds !== null) {
      try {
        await verifyAccountOwnership(userId, replaceAccountIds);
      } catch (e) {
        return NextResponse.json({ error: safeErrorMessage(e, "Invalid account") }, { status: 400 });
      }
    }

    // GH #423: judge the goal as it will be AFTER this update (mode, start
    // date and accounts can each arrive alone).
    if (data.progressMode !== undefined || data.startDate !== undefined || replaceAccountIds !== null) {
      const current = await db
        .select({ progressMode: schema.goals.progressMode, startDate: schema.goals.startDate })
        .from(schema.goals)
        .where(and(eq(schema.goals.id, id), eq(schema.goals.userId, userId)))
        .get();
      if (!current) return NextResponse.json({ error: "Goal not found" }, { status: 404 });
      const nextMode = data.progressMode ?? normalizeProgressMode(current.progressMode);
      const nextStart = nextMode === "growth"
        ? (data.startDate !== undefined ? data.startDate || null : current.startDate)
        : null;
      const nextAccounts = replaceAccountIds ?? (
        await db
          .select({ accountId: schema.goalAccounts.accountId })
          .from(schema.goalAccounts)
          .where(and(eq(schema.goalAccounts.goalId, id), eq(schema.goalAccounts.userId, userId)))
      ).map((r) => r.accountId);
      const modeRefusal = growthGoalRefusal({
        progressMode: nextMode,
        startDate: nextStart,
        accountIds: nextAccounts,
        today: todayISO(),
      });
      if (modeRefusal) return NextResponse.json({ error: modeRefusal }, { status: 400 });
      data.progressMode = nextMode;
      data.startDate = nextStart;
    }

    // Stream D Phase 4 — plaintext `name` dropped; only encrypted siblings persist.
    // Build the UPDATE set including the legacy `accountId` mirror only when
    // `accountIds` was supplied (issue #130 — keep first id as legacy fallback).
    const updatePayload: Record<string, unknown> = { ...data, ...enc };
    // Encrypt the free-text note when present (2026-06-01 plaintext-gap closure).
    if (data.note !== undefined) {
      updatePayload.note = encryptOptional(dek, data.note);
    }
    if (replaceAccountIds !== null) {
      updatePayload.accountId = replaceAccountIds[0] ?? null;
    }
    // The row UPDATE and the join replacement (DELETE existing + INSERT new,
    // only when the caller supplied a fresh account list) go in ONE
    // transaction — a failure between them used to leave the goal tracking
    // ZERO accounts, i.e. permanently reporting $0 progress (review API-M2).
    const goal = await withDbTransaction(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const goalRows = await db.update(schema.goals).set(updatePayload as any).where(and(eq(schema.goals.id, id), eq(schema.goals.userId, userId))).returning();
      if (replaceLinks !== null) {
        await db
          .delete(schema.goalAccounts)
          .where(and(eq(schema.goalAccounts.goalId, id), eq(schema.goalAccounts.userId, userId)));
        if (replaceLinks.length > 0) {
          await db.insert(schema.goalAccounts).values(linkRows(userId, id, replaceLinks));
        }
      }
      return goalRows[0];
    });

    return NextResponse.json(goal);
  } catch (error: unknown) {
    const duplicate = duplicateNameResponse(error);
    if (duplicate) return duplicate;
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // ON DELETE CASCADE on goal_accounts.goal_id handles the join cleanup,
  // but the explicit delete keeps the wipe predictable.
  await db
    .delete(schema.goalAccounts)
    .where(and(eq(schema.goalAccounts.goalId, id), eq(schema.goalAccounts.userId, auth.context.userId)));
  await db.delete(schema.goals).where(and(eq(schema.goals.id, id), eq(schema.goals.userId, auth.context.userId)));
  return NextResponse.json({ success: true });
}
