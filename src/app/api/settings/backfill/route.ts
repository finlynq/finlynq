/**
 * POST /api/settings/backfill — create a new backfill run and plan it
 * GET  /api/settings/backfill — list user's recent backfill runs
 *
 * Both require an unlocked session (DEK) because the planner decrypts
 * display names for proposal summaries. See pf-app/docs/architecture/backfill.md.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { loadLedgerSnapshot } from "@/lib/portfolio/backfill/apply";
import { planBackfill } from "@/lib/portfolio/backfill/planner";

const createSchema = z.object({
  mode: z.enum(["refuse_orphans", "synthesize_orphans"]),
  scope: z
    .object({
      accountIds: z.array(z.number().int().positive()).optional(),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      stagedImportId: z.string().uuid().optional(),
    })
    .default({}),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, createSchema);
    if (parsed.error) return parsed.error;
    const { mode, scope } = parsed.data;

    // Plan first; we want to know if there's anything to do before
    // persisting an empty run.
    const snapshot = await loadLedgerSnapshot(auth.userId, auth.dek, scope);
    const proposals = planBackfill(snapshot, { mode, scope });

    // Create the run row.
    const runInserted = await db
      .insert(schema.backfillRuns)
      .values({
        userId: auth.userId,
        mode,
        scopeFilter: scope,
        status: proposals.length === 0 ? "ready" : "ready",
      })
      .returning({ id: schema.backfillRuns.id });
    const runId = runInserted[0]?.id;
    if (!runId) {
      return NextResponse.json({ error: "Failed to create run" }, { status: 500 });
    }

    // Insert proposals; collect DB ids so we can map the in-memory dependsOn
    // indices to persisted ids.
    const proposalIdByIndex = new Map<number, number>();
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i];
      const isDrift = p.kind === "drift";
      const persistedReplacementJson = isDrift && p.variants
        ? p.variants
        : p.replacement;
      const inserted = await db
        .insert(schema.backfillProposals)
        .values({
          runId,
          userId: auth.userId,
          proposalKind: p.kind,
          confidence: p.confidence,
          refusalReason: p.refusalReason ?? null,
          summary: p.summary,
          existingRowIds: p.existingRowIds,
          replacementRowsJson: persistedReplacementJson,
          synthesizedRowsJson: p.synthesized.length > 0 ? p.synthesized : null,
          deltasJson: p.deltas,
          // Will rewrite once all proposals have ids
          dependsOnProposalIds: [],
          variantChoice: null,
          // Surface the planner's per-proposal candidate list to the
          // picker UI. Empty for proposals that don't need a holding pick.
          candidateHoldingIds: p.candidateHoldingIds ?? [],
          status: p.confidence === "refused" ? "refused_with_reason" : "pending",
        })
        .returning({ id: schema.backfillProposals.id });
      const id = inserted[0]?.id;
      if (id != null) proposalIdByIndex.set(i, id);
    }
    // Now rewrite dependsOn arrays with persisted ids.
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i];
      if (p.dependsOn.length === 0) continue;
      const dbId = proposalIdByIndex.get(i);
      if (dbId == null) continue;
      const deps = p.dependsOn
        .map((idx) => proposalIdByIndex.get(idx))
        .filter((v): v is number => v != null);
      if (deps.length === 0) continue;
      await db
        .update(schema.backfillProposals)
        .set({ dependsOnProposalIds: deps })
        .where(eq(schema.backfillProposals.id, dbId));
    }

    return NextResponse.json(
      { runId, proposalCount: proposals.length },
      { status: 201 },
    );
  } catch (err: unknown) {
    await logApiError("POST", "/api/settings/backfill", err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to create backfill run") },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const runs = await db
      .select({
        id: schema.backfillRuns.id,
        mode: schema.backfillRuns.mode,
        scopeFilter: schema.backfillRuns.scopeFilter,
        status: schema.backfillRuns.status,
        createdAt: schema.backfillRuns.createdAt,
        appliedAt: schema.backfillRuns.appliedAt,
      })
      .from(schema.backfillRuns)
      .where(eq(schema.backfillRuns.userId, auth.userId))
      .orderBy(desc(schema.backfillRuns.createdAt))
      .limit(20);
    return NextResponse.json({ runs });
  } catch (err: unknown) {
    await logApiError("GET", "/api/settings/backfill", err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to list backfill runs") },
      { status: 500 },
    );
  }
}
