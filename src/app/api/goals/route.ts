import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage, AppError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { computeGoalProgress } from "@/lib/goals-progress";

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
  priority: z.number().optional(),
  status: z.string().optional(),
  note: z.string().optional(),
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
  priority: z.number().optional(),
  status: z.string().optional(),
  note: z.string().optional(),
});

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
    })
    .from(schema.goals)
    .where(eq(schema.goals.userId, userId))
    .orderBy(schema.goals.priority);

  // Pull every (goal_id, account_id, account_name_ct) link in one query and
  // group by goal id so the response carries `accountIds: number[]` and
  // decrypted `accounts: string[]` (issue #130).
  const goalIds = rawGoals.map((g) => g.id);
  const links: Array<{ goalId: number; accountId: number; accountNameCt: string | null }> =
    goalIds.length > 0
      ? await db
          .select({
            goalId: schema.goalAccounts.goalId,
            accountId: schema.goalAccounts.accountId,
            accountNameCt: schema.accounts.nameCt,
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
  const linksByGoal = new Map<number, { ids: number[]; names: string[] }>();
  for (const link of linksDecrypted) {
    const entry = linksByGoal.get(link.goalId) ?? { ids: [], names: [] };
    entry.ids.push(link.accountId);
    entry.names.push(link.accountName ?? "");
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
      currency: g.currency ?? null,
      targetAmount: g.targetAmount,
      deadline: g.deadline ?? null,
      accountIds: g.accountIds,
    })),
  );

  const withProgress = goals.map((g) => {
    const p = progressByGoal.get(g.id);
    return {
      ...g,
      currentAmount: p?.currentAmount ?? 0,
      progress: p?.progress ?? 0,
      // Issue #233: alias `percentComplete` matches the MCP `get_goals`
      // docstring's "with progress" promise. Same number as `progress`.
      percentComplete: p?.progress ?? 0,
      remaining: p?.remaining ?? g.targetAmount,
      monthlyNeeded: p?.monthlyNeeded ?? 0,
    };
  });

  return NextResponse.json(withProgress);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;
    const accountIds = resolveAccountIds(d) ?? [];
    try {
      await verifyAccountOwnership(auth.context.userId, accountIds);
    } catch (e) {
      return NextResponse.json({ error: safeErrorMessage(e, "Invalid account") }, { status: 400 });
    }
    const enc = buildNameFields(auth.context.dek, { name: d.name });
    // Stream D Phase 4 — plaintext `name` column dropped; only encrypted
    // siblings persist. Issue #130: dual-write `goals.account_id` (first id
    // only, legacy fallback) and the `goal_accounts` join.
    const inserted = await db.insert(schema.goals).values({
      userId: auth.context.userId,
      type: d.type,
      targetAmount: d.targetAmount,
      ...(d.currency ? { currency: d.currency.toUpperCase() } : {}),
      deadline: d.deadline || null,
      accountId: accountIds[0] ?? null,
      priority: d.priority ?? 1,
      status: d.status ?? "active",
      note: d.note ?? "",
      ...enc,
    }).returning({ id: schema.goals.id });
    const newId = inserted[0]?.id;
    if (newId && accountIds.length > 0) {
      await db.insert(schema.goalAccounts).values(
        accountIds.map((accountId) => ({
          userId: auth.context.userId,
          goalId: newId,
          accountId,
        })),
      );
    }
    // Re-read the row so the response carries the canonical shape.
    const goal = newId
      ? (await db.select().from(schema.goals).where(eq(schema.goals.id, newId)))[0]
      : null;
    return NextResponse.json({ ...goal, accountIds }, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, name, accountId: _legacyAccountId, accountIds: _newAccountIds, ...data } = parsed.data;
    void _legacyAccountId; void _newAccountIds;
    const toEncrypt: Record<string, string | null | undefined> = {};
    if (name !== undefined) toEncrypt.name = name;
    const enc = buildNameFields(auth.context.dek, toEncrypt);
    if (data.currency) data.currency = data.currency.toUpperCase();

    // Did the caller intend to change account links? Only touch the join
    // when explicitly supplied — passing neither leaves links alone.
    const replaceAccountIds = resolveAccountIds(parsed.data);
    if (replaceAccountIds !== null) {
      try {
        await verifyAccountOwnership(auth.context.userId, replaceAccountIds);
      } catch (e) {
        return NextResponse.json({ error: safeErrorMessage(e, "Invalid account") }, { status: 400 });
      }
    }

    // Stream D Phase 4 — plaintext `name` dropped; only encrypted siblings persist.
    // Build the UPDATE set including the legacy `accountId` mirror only when
    // `accountIds` was supplied (issue #130 — keep first id as legacy fallback).
    const updatePayload: Record<string, unknown> = { ...data, ...enc };
    if (replaceAccountIds !== null) {
      updatePayload.accountId = replaceAccountIds[0] ?? null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const goalRows = await db.update(schema.goals).set(updatePayload as any).where(and(eq(schema.goals.id, id), eq(schema.goals.userId, auth.context.userId))).returning();
    const goal = goalRows[0];

    // Replace the join (DELETE existing + INSERT new) only when the caller
    // supplied a fresh account list. Atomic-enough on PostgreSQL — the
    // surrounding request is serialized; a partial state would only show
    // briefly under concurrent edits to the same goal.
    if (replaceAccountIds !== null) {
      await db
        .delete(schema.goalAccounts)
        .where(and(eq(schema.goalAccounts.goalId, id), eq(schema.goalAccounts.userId, auth.context.userId)));
      if (replaceAccountIds.length > 0) {
        await db.insert(schema.goalAccounts).values(
          replaceAccountIds.map((accountId) => ({
            userId: auth.context.userId,
            goalId: id,
            accountId,
          })),
        );
      }
    }

    return NextResponse.json(goal);
  } catch (error: unknown) {
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
