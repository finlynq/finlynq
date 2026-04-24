import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  runWealthPositionExecute,
  type MappingInput,
} from "@/lib/external-import/orchestrator";
import { WealthPositionApiError } from "@finlynq/import-connectors/wealthposition";

const autoCreateAccountSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().min(1).max(10),
    group: z.string().max(200),
    currency: z.string().min(1).max(10),
  })
  .optional();

const autoCreateCategorySchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.string().min(1).max(10),
    group: z.string().max(200),
  })
  .optional();

const executeSchema = z.object({
  confirmationToken: z.string().min(1).max(2000),
  forceImportIndices: z.array(z.number().int().min(0)).max(50000).optional(),
  mapping: z.object({
    accounts: z
      .array(
        z.object({
          externalId: z.string().min(1),
          finlynqId: z.number().int().optional(),
          autoCreate: autoCreateAccountSchema,
        }),
      )
      .max(1000),
    categories: z
      .array(
        z.object({
          externalId: z.string().min(1),
          finlynqId: z.number().int().optional(),
          uncategorized: z.boolean().optional(),
          autoCreate: autoCreateCategorySchema,
        }),
      )
      .max(1000),
    transferCategoryId: z.number().int().nullable(),
    transferCategoryAutoCreate: z
      .object({ name: z.string().min(1).max(200), group: z.string().max(200) })
      .optional(),
    openingBalanceCategoryId: z.number().int().nullable(),
    openingBalanceCategoryAutoCreate: z
      .object({ name: z.string().min(1).max(200), group: z.string().max(200) })
      .optional(),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = executeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const mapping = parsed.data.mapping as MappingInput;

  try {
    const result = await runWealthPositionExecute(
      auth.userId,
      auth.dek,
      mapping,
      parsed.data.confirmationToken,
      parsed.data.forceImportIndices ?? [],
    );
    return NextResponse.json({
      import: result.import,
      splitsInserted: result.splitsInserted,
      splitInsertErrors: result.splitInsertErrors,
      transformErrors: result.transformErrors,
      syncWatermark: result.syncWatermark,
    });
  } catch (err) {
    if (err instanceof WealthPositionApiError) {
      const status = err.httpStatus === 401 || err.code === "AUTHENTICATION_ERROR" ? 401 : 502;
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status },
      );
    }
    const message = err instanceof Error ? err.message : "Sync failed";
    const status = message.includes("Confirmation token") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
